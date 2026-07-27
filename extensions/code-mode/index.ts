import * as crypto from "node:crypto"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import {
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionRunner,
	ExtensionRunner as ImportedExtensionRunner,
	type RegisteredTool,
	type Theme,
	type ToolDefinition,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	defineTool,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent"
import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui"
import releaseSyncVariant from "@jitl/quickjs-singlefile-mjs-release-sync"
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core"
import { type Static, type TSchema, Type } from "typebox"
import { Value } from "typebox/value"
import * as ts from "typescript"

const TRACE_ENTRY_TYPE = "code-mode-trace"
const TRACE_KIND = "pi-code-mode.trace"
const TRACE_VERSION = 1
const RESULT_KIND = "pi-code-mode.result"
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024
const TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const

type BuiltinToolName = (typeof TOOL_NAMES)[number]
type PiToolRef = `${"pi" | "extensions"}.${string}`
type QuickJsModule = Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>>
type ToolContent = AgentToolResult<unknown>["content"]
// biome-ignore lint/suspicious/noExplicitAny: Pi exposes heterogeneous tool definitions; this alias keeps that boundary contained.
type CapturedToolDefinition = ToolDefinition<TSchema, any, any>

type FailureStage = "decode" | "validate" | "guard" | "lifecycle" | "invoke" | "result_encode"

let quickJsModulePromise: Promise<QuickJsModule> | undefined

const quickJsModule = (): Promise<QuickJsModule> => {
	quickJsModulePromise ??= newQuickJSWASMModuleFromVariant(releaseSyncVariant)
	return quickJsModulePromise
}

const codeExecSchema = Type.Object({
	code: Type.String({
		description:
			"TypeScript/JavaScript function body to run in code mode. Use synchronous-looking pi.* calls and return a final value.",
	}),
	timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 300_000 })),
	memoryLimitBytes: Type.Optional(Type.Number({ minimum: 1024 * 1024, maximum: 512 * 1024 * 1024 })),
})

type CodeExecInput = Static<typeof codeExecSchema>

const toolTextContentPartSchema = Type.Object({
	type: Type.Literal("text"),
	text: Type.String(),
})

const toolImageContentPartSchema = Type.Object({
	type: Type.Literal("image"),
	data: Type.String(),
	mimeType: Type.String(),
})

const toolResultDetailsSchema = Type.Record(Type.String(), Type.Unknown())

const toolResultSchema = Type.Object({
	content: Type.Array(Type.Union([toolTextContentPartSchema, toolImageContentPartSchema])),
	details: Type.Optional(toolResultDetailsSchema),
})

type ToolImageContentPart = Static<typeof toolImageContentPartSchema>
type PiToolResult = Static<typeof toolResultSchema>

type HostCall = {
	readonly ref: PiToolRef
	readonly args: Record<string, unknown>
}

type HostOkResponse = {
	readonly ref: PiToolRef
	readonly status: "ok"
	readonly value: PiToolResult
}

type HostErrorResponse = {
	readonly ref: PiToolRef | "unknown"
	readonly status: "error"
	readonly stage: FailureStage
	readonly error: string
}

type HostResponse = HostOkResponse | HostErrorResponse

type TraceOperation =
	| {
			readonly sequence: number
			readonly toolCallId: string
			readonly startedAt: string
			readonly endedAt: string
			readonly outcome: "ok"
			readonly call: HostCall
			readonly response: HostOkResponse
	  }
	| {
			readonly sequence: number
			readonly toolCallId: string
			readonly startedAt: string
			readonly endedAt: string
			readonly outcome: "error"
			readonly stage: FailureStage
			readonly ref: PiToolRef | "unknown"
			readonly error: string
			readonly response: HostErrorResponse
			readonly call?: HostCall
			readonly rawEnvelope?: string
	  }

interface CodeModeTraceV1 {
	readonly kind: typeof TRACE_KIND
	readonly version: typeof TRACE_VERSION
	readonly executionId: string
	readonly toolCallId: string
	readonly cwd: string
	readonly startedAt: string
	readonly endedAt: string
	readonly success: boolean
	readonly codeSha256: string
	readonly prints: readonly string[]
	readonly operations: readonly TraceOperation[]
	readonly result?: unknown
	readonly error?: string
}

const renderOperationSchema = Type.Object({
	sequence: Type.Number(),
	toolCallId: Type.String(),
	ref: Type.String(),
	outcome: Type.Union([Type.Literal("running"), Type.Literal("ok"), Type.Literal("error")]),
	startedAt: Type.String(),
	endedAt: Type.Optional(Type.String()),
	args: Type.Optional(Type.Unknown()),
	result: Type.Optional(toolResultSchema),
	stage: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
	rawEnvelope: Type.Optional(Type.Unknown()),
})

const resultDetailsSchema = Type.Object({
	kind: Type.Literal(RESULT_KIND),
	version: Type.Literal(TRACE_VERSION),
	executionId: Type.String(),
	traceEntryType: Type.Literal(TRACE_ENTRY_TYPE),
	success: Type.Boolean(),
	status: Type.Optional(Type.Union([Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed")])),
	result: Type.Optional(Type.Unknown()),
	prints: Type.Array(Type.String()),
	operationCount: Type.Number(),
	imageCount: Type.Optional(Type.Number()),
	operations: Type.Optional(Type.Array(renderOperationSchema)),
	error: Type.Optional(Type.String()),
})

type CodeExecRenderOperation = Static<typeof renderOperationSchema>
type CodeExecResultDetails = Static<typeof resultDetailsSchema>

interface NestedRendererSlot {
	call?: Component
	result?: Component
	state: Record<string, unknown>
}

interface CodeExecRendererState {
	nestedSlots?: Map<number, NestedRendererSlot>
}

interface ToolCatalogEntry {
	readonly definition: CapturedToolDefinition
	readonly registeredTool: RegisteredTool
	readonly runner: ExtensionRunner
}

interface ToolCatalog {
	replace(tools: RegisteredTool[], runner: ExtensionRunner, ownSourcePath: string): void
	get(name: string): ToolCatalogEntry | undefined
	list(): ToolCatalogEntry[]
	readonly runner: ExtensionRunner | undefined
}

class CodeModeBoundaryError extends Error {
	constructor(
		readonly stage: FailureStage,
		message: string,
	) {
		super(message)
		this.name = "CodeModeBoundaryError"
	}
}

class CodeModeRuntimeError extends Error {
	constructor(
		message: string,
		readonly prints: readonly string[],
		readonly operations: readonly TraceOperation[],
	) {
		super(message)
		this.name = "CodeModeRuntimeError"
	}
}

class InMemoryToolCatalog implements ToolCatalog {
	#tools = new Map<string, ToolCatalogEntry>()
	#runner: ExtensionRunner | undefined

	get runner(): ExtensionRunner | undefined {
		return this.#runner
	}

	replace(tools: RegisteredTool[], runner: ExtensionRunner, ownSourcePath: string): void {
		this.#runner = runner
		this.#tools.clear()
		for (const registeredTool of tools) {
			if (registeredTool.sourceInfo.path === ownSourcePath) continue
			this.#tools.set(registeredTool.definition.name, {
				definition: registeredTool.definition as CapturedToolDefinition,
				registeredTool,
				runner,
			})
		}
	}

	get(name: string): ToolCatalogEntry | undefined {
		return this.#tools.get(name)
	}

	list(): ToolCatalogEntry[] {
		return [...this.#tools.values()]
	}
}

type ToolCaptureListener = (tools: RegisteredTool[], runner: ExtensionRunner) => RegisteredTool[]

interface ToolCaptureHub {
	readonly listeners: Set<ToolCaptureListener>
}

type ExtensionRunnerConstructor = {
	prototype: ExtensionRunner
}

const HUB_SYMBOL = Symbol.for("pi-code-mode.registered-tool-capture.v1")
const ANCHOR_SYMBOL = Symbol.for("pi-code-mode.anchor.v1")

const captureHub = (Runner: ExtensionRunnerConstructor): ToolCaptureHub => {
	const prototype = Runner.prototype as ExtensionRunner & Record<PropertyKey, unknown>
	const existing = prototype[HUB_SYMBOL] as ToolCaptureHub | undefined
	if (existing) return existing

	const original = prototype.getAllRegisteredTools
	if (typeof original !== "function")
		throw new Error("code-mode could not intercept ExtensionRunner.getAllRegisteredTools")

	const hub: ToolCaptureHub = { listeners: new Set() }
	Object.defineProperty(prototype, HUB_SYMBOL, {
		value: hub,
		configurable: false,
		enumerable: false,
		writable: false,
	})
	prototype.getAllRegisteredTools = function getCodeModeVisibleTools(): RegisteredTool[] {
		let tools = original.call(this)
		for (const listener of [...hub.listeners]) tools = listener(tools, this)
		return tools
	}
	return hub
}

const hostPackageRoot = (): string | undefined => {
	const cliPath = process.argv[1]
	if (!cliPath) return undefined
	let directory: string
	try {
		directory = path.dirname(realpathSync(cliPath))
	} catch {
		return undefined
	}
	while (directory !== path.dirname(directory)) {
		const manifestPath = path.join(directory, "package.json")
		if (existsSync(manifestPath)) {
			try {
				const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown }
				if (manifest.name === "@earendil-works/pi-coding-agent") return directory
			} catch {
				// keep walking
			}
		}
		directory = path.dirname(directory)
	}
	return undefined
}

const extensionRunnerConstructors = async (): Promise<ExtensionRunnerConstructor[]> => {
	const constructors = new Set<ExtensionRunnerConstructor>([ImportedExtensionRunner])
	for (const packageRoot of [process.env.PI_PACKAGE_DIR, hostPackageRoot()].filter((root): root is string =>
		Boolean(root),
	)) {
		try {
			const hostEntry = path.join(packageRoot, "dist", "index.js")
			const hostModule = (await import(pathToFileURL(hostEntry).href)) as {
				ExtensionRunner?: ExtensionRunnerConstructor
			}
			if (hostModule.ExtensionRunner) constructors.add(hostModule.ExtensionRunner)
		} catch {
			// best-effort: the imported constructor usually already matches
		}
	}
	return [...constructors]
}

const installToolCapture = async (
	anchorDefinition: CapturedToolDefinition,
	catalog: ToolCatalog,
): Promise<() => void> => {
	const anchorToken = {}
	Object.defineProperty(anchorDefinition, ANCHOR_SYMBOL, {
		value: anchorToken,
		configurable: false,
		enumerable: false,
		writable: false,
	})

	const listener: ToolCaptureListener = (tools, runner) => {
		const anchor = tools.find(
			(tool) => (tool.definition as unknown as Record<PropertyKey, unknown>)[ANCHOR_SYMBOL] === anchorToken,
		)
		if (!anchor) return tools
		catalog.replace(tools, runner, anchor.sourceInfo.path)
		return tools
	}

	const hubs = (await extensionRunnerConstructors()).map(captureHub)
	for (const hub of hubs) hub.listeners.add(listener)
	return () => {
		for (const hub of hubs) hub.listeners.delete(listener)
	}
}

const builtInTools = (cwd: string): Record<BuiltinToolName, CapturedToolDefinition> => ({
	read: createReadToolDefinition(cwd) as CapturedToolDefinition,
	bash: createBashToolDefinition(cwd) as CapturedToolDefinition,
	edit: createEditToolDefinition(cwd) as CapturedToolDefinition,
	write: createWriteToolDefinition(cwd) as CapturedToolDefinition,
	grep: createGrepToolDefinition(cwd) as CapturedToolDefinition,
	find: createFindToolDefinition(cwd) as CapturedToolDefinition,
	ls: createLsToolDefinition(cwd) as CapturedToolDefinition,
})

type ToolProvider = "pi" | "extensions"

interface ToolRegistryEntry {
	readonly ref: PiToolRef
	readonly provider: ToolProvider
	readonly name: string
	readonly definition: CapturedToolDefinition
}

const refForTool = (provider: ToolProvider, name: string): PiToolRef => `${provider}.${name}` as PiToolRef

const parseToolRef = (ref: string): { provider: ToolProvider; name: string } | undefined => {
	const separator = ref.indexOf(".")
	if (separator <= 0) return undefined
	const provider = ref.slice(0, separator)
	if (provider !== "pi" && provider !== "extensions") return undefined
	const name = ref.slice(separator + 1)
	return name ? { provider, name } : undefined
}

const builtinToolEntries = (cwd: string, catalog: ToolCatalog): ToolRegistryEntry[] => {
	const builtins = builtInTools(cwd)
	return TOOL_NAMES.map((name) => ({
		ref: refForTool("pi", name),
		provider: "pi" as const,
		name,
		definition: catalog.get(name)?.definition ?? builtins[name],
	}))
}

const extensionToolEntries = (catalog: ToolCatalog): ToolRegistryEntry[] =>
	catalog
		.list()
		.filter((entry) => !(TOOL_NAMES as readonly string[]).includes(entry.definition.name))
		.map((entry) => ({
			ref: refForTool("extensions", entry.definition.name),
			provider: "extensions" as const,
			name: entry.definition.name,
			definition: entry.definition,
		}))

const toolRegistry = (cwd: string, catalog: ToolCatalog): ToolRegistryEntry[] => [
	...builtinToolEntries(cwd, catalog),
	...extensionToolEntries(catalog),
]

const toolDefinitionForRef = (cwd: string, catalog: ToolCatalog, ref: string): ToolRegistryEntry | undefined => {
	const parsed = parseToolRef(ref)
	if (!parsed) return undefined
	return toolRegistry(cwd, catalog).find((entry) => entry.provider === parsed.provider && entry.name === parsed.name)
}

const textContent = (content: ToolContent): string =>
	content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")

const typeBoxErrorMessage = (schema: TSchema, value: unknown, label: string): string => {
	try {
		const messages = [...Value.Errors(schema, value)]
			.slice(0, 5)
			.map((error) => {
				const path =
					(error as { instancePath?: unknown; path?: unknown }).instancePath ?? (error as { path?: unknown }).path
				return `${typeof path === "string" && path ? path : "value"} ${error.message}`
			})
			.join("; ")
		return messages ? `${label}: ${messages}` : `${label}: schema validation failed`
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return `${label}: schema validator failed: ${message}`
	}
}

const assertTypeBox = <T>(schema: TSchema, value: unknown, label: string): T => {
	if (Value.Check(schema, value)) return value as T
	throw new Error(typeBoxErrorMessage(schema, value, label))
}

const validateToolArgs = (definition: CapturedToolDefinition, value: unknown, label: string): Record<string, unknown> =>
	assertTypeBox<Record<string, unknown>>(definition.parameters, value, label)

const prepareArgs = (definition: CapturedToolDefinition, args: unknown): unknown => {
	if (!definition.prepareArguments) return args
	return definition.prepareArguments(args)
}

const hostOkResponseSchema = Type.Object({ ref: Type.String(), status: Type.Literal("ok"), value: toolResultSchema })

const hostErrorResponseSchema = Type.Object({
	ref: Type.Union([Type.String(), Type.Literal("unknown")]),
	status: Type.Literal("error"),
	stage: Type.Union([
		Type.Literal("decode"),
		Type.Literal("validate"),
		Type.Literal("guard"),
		Type.Literal("lifecycle"),
		Type.Literal("invoke"),
		Type.Literal("result_encode"),
	]),
	error: Type.String(),
})

const hostResponseSchema = Type.Union([hostOkResponseSchema, hostErrorResponseSchema])

const hostCallSchemaFor = (ref: PiToolRef, argsSchema: TSchema): TSchema =>
	Type.Object({ ref: Type.Literal(ref), args: argsSchema })

const hostCallSchema = (cwd: string, catalog: ToolCatalog): TSchema => {
	const entries = toolRegistry(cwd, catalog)
	return Type.Union(entries.map((entry) => hostCallSchemaFor(entry.ref, entry.definition.parameters)))
}

const decodeHostCall = (rawEnvelope: string, cwd: string, catalog: ToolCatalog): HostCall => {
	let decoded: unknown
	try {
		decoded = JSON.parse(rawEnvelope)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new CodeModeBoundaryError("decode", `Invalid host-call JSON: ${message}`)
	}
	try {
		if (!decoded || typeof decoded !== "object") throw new Error("expected object envelope")
		const envelope = decoded as { ref?: unknown; args?: unknown }
		if (typeof envelope.ref !== "string") throw new Error("ref must be string")
		const entry = toolDefinitionForRef(cwd, catalog, envelope.ref)
		if (!entry) throw new Error(`unknown tool ref ${envelope.ref}`)
		const args = assertTypeBox<Record<string, unknown>>(
			entry.definition.parameters,
			envelope.args ?? {},
			`Invalid arguments for ${entry.ref}`,
		)
		return { ref: entry.ref, args }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new CodeModeBoundaryError("validate", message)
	}
}

const toolResultValue = (result: AgentToolResult<unknown>): PiToolResult => {
	const value = {
		content: result.content,
		...(result.details !== undefined ? { details: result.details } : {}),
	}
	return assertTypeBox<PiToolResult>(toolResultSchema, value, "Invalid Pi tool result")
}

const okResponseFromToolResult = (ref: PiToolRef, result: AgentToolResult<unknown>): HostOkResponse => {
	const response: HostOkResponse = { ref, status: "ok", value: toolResultValue(result) }
	return assertTypeBox<HostOkResponse>(hostOkResponseSchema, response, "Invalid host response")
}

const errorResponse = (ref: PiToolRef | "unknown", stage: FailureStage, error: string): HostErrorResponse =>
	assertTypeBox<HostErrorResponse>(
		hostErrorResponseSchema,
		{ ref, status: "error", stage, error },
		"Invalid host error response",
	)

const validateHostResponse = (response: HostResponse): HostResponse =>
	assertTypeBox<HostResponse>(hostResponseSchema, response, "Invalid host response")

const invokePiTool = async (input: {
	call: HostCall
	outerToolCallId: string
	sequence: number
	context: ExtensionContext
	catalog: ToolCatalog
	signal: AbortSignal | undefined
	onUpdate?: (partialResult: AgentToolResult<unknown>) => void
}): Promise<HostOkResponse> => {
	const entry = toolDefinitionForRef(input.context.cwd, input.catalog, input.call.ref)
	if (!entry) throw new CodeModeBoundaryError("validate", `unknown tool ref ${input.call.ref}`)
	const { name, definition } = entry
	const runner = input.catalog.get(name)?.runner ?? input.catalog.runner
	if (!runner) {
		throw new CodeModeBoundaryError(
			"lifecycle",
			"code-mode cannot invoke pi tools because the Pi tool lifecycle runner is unavailable",
		)
	}

	let preparedArgs: Record<string, unknown>
	try {
		preparedArgs = validateToolArgs(
			definition,
			prepareArgs(definition, input.call.args),
			`Invalid arguments for ${input.call.ref}`,
		)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new CodeModeBoundaryError("validate", message)
	}

	const toolCallId = `${input.outerToolCallId}:code:${input.sequence}:${name}`
	await runner.emit({ type: "tool_execution_start", toolCallId, toolName: name, args: preparedArgs })
	let result: AgentToolResult<unknown>
	let isError = false
	let failedStage: FailureStage = "invoke"
	try {
		try {
			const preflight = await runner.emitToolCall({
				type: "tool_call",
				toolName: name,
				toolCallId,
				input: preparedArgs,
			})
			if (preflight?.block) throw new CodeModeBoundaryError("guard", preflight.reason || `${name} blocked`)
		} catch (error) {
			failedStage = error instanceof CodeModeBoundaryError ? error.stage : "guard"
			throw error
		}
		result = await definition.execute(toolCallId, preparedArgs, input.signal, input.onUpdate, input.context)
	} catch (error) {
		isError = true
		if (error instanceof CodeModeBoundaryError) failedStage = error.stage
		result = {
			content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
			details: undefined,
		}
	}

	try {
		const patch = await runner.emitToolResult({
			type: "tool_result",
			toolName: name,
			toolCallId,
			input: preparedArgs,
			content: result.content,
			details: result.details,
			isError,
		})
		if (patch) {
			result = {
				...result,
				content: patch.content ?? result.content,
				...(patch.details !== undefined ? { details: patch.details } : {}),
			}
			isError = patch.isError ?? isError
		}
		await runner.emit({ type: "tool_execution_end", toolCallId, toolName: name, result, isError })
	} catch (error) {
		throw new CodeModeBoundaryError("lifecycle", error instanceof Error ? error.message : String(error))
	}

	if (isError) throw new CodeModeBoundaryError(failedStage, textContent(result.content) || `${name} failed`)
	try {
		return okResponseFromToolResult(input.call.ref, result)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new CodeModeBoundaryError("result_encode", message)
	}
}

const schemaDescription = (schema: TSchema): string | undefined => {
	const description = (schema as { description?: unknown }).description
	return typeof description === "string" && description.trim() ? description : undefined
}

const commentForDescription = (description: string, indent = ""): string =>
	description
		.split("\n")
		.map((line) => `${indent}/** ${line.replaceAll("*/", "* /")} */`)
		.join("\n")

const literalToTypeScript = (value: unknown): string => {
	if (typeof value === "string") return JSON.stringify(value)
	if (typeof value === "number" || typeof value === "boolean") return String(value)
	if (value === null) return "null"
	return "unknown"
}

const typeboxToTypeScript = (schema: TSchema): string => {
	const record = schema as {
		type?: unknown
		const?: unknown
		properties?: Record<string, TSchema>
		required?: string[]
		items?: TSchema
		anyOf?: TSchema[]
		oneOf?: TSchema[]
		allOf?: TSchema[]
		patternProperties?: Record<string, TSchema>
		additionalProperties?: TSchema | boolean
	}
	if (Object.hasOwn(record, "const")) return literalToTypeScript(record.const)
	if (Array.isArray(record.anyOf)) return record.anyOf.map(typeboxToTypeScript).join(" | ")
	if (Array.isArray(record.oneOf)) return record.oneOf.map(typeboxToTypeScript).join(" | ")
	if (Array.isArray(record.allOf)) return record.allOf.map(typeboxToTypeScript).join(" & ")
	if (record.type === "string") return "string"
	if (record.type === "number" || record.type === "integer") return "number"
	if (record.type === "boolean") return "boolean"
	if (record.type === "null") return "null"
	if (record.type === "array") return `Array<${record.items ? typeboxToTypeScript(record.items) : "unknown"}>`
	if (record.type === "object" && record.patternProperties) {
		const valueSchema = Object.values(record.patternProperties)[0]
		return `Record<string, ${valueSchema ? typeboxToTypeScript(valueSchema) : "unknown"}>`
	}
	if (record.type === "object" && typeof record.additionalProperties === "object") {
		return `Record<string, ${typeboxToTypeScript(record.additionalProperties)}>`
	}
	if (record.type === "object" && record.properties) {
		const required = new Set(record.required ?? [])
		const fields = Object.entries(record.properties).map(([key, propertySchema]) => {
			const description = schemaDescription(propertySchema)
			const property = `${JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${typeboxToTypeScript(propertySchema)}`
			return description ? `${commentForDescription(description, "  ")}\n  ${property}` : `  ${property}`
		})
		return fields.length > 0 ? `{\n${fields.join("\n")}\n}` : "Record<string, never>"
	}
	return "unknown"
}

const guestToolDescription = (name: string, description: string | undefined): string => {
	const normalizedDescription =
		name === "bash"
			? description?.replace(
					"Returns stdout and stderr.",
					"Returns a PiToolResult whose text content contains the command output.",
				)
			: description
	const resultNote =
		name === "bash"
			? "Code-mode result: returns PiToolResult. Pi's bash tool exposes merged textual command output in content; it does not expose stdout/stderr/exitCode/output fields."
			: "Code-mode result: returns PiToolResult with content blocks and optional tool-specific details. Treat details as opaque unless you narrow/cast it."
	return [normalizedDescription, resultNote].filter(Boolean).join("\n\n")
}

interface ToolDeclarationEntry extends ToolRegistryEntry {
	readonly typeName: string
}

const identifierPart = (value: string): string => value.replace(/[^A-Za-z0-9_$]/g, "_") || "tool"

const toolDeclarationEntries = (cwd: string, catalog: ToolCatalog): ToolDeclarationEntry[] =>
	toolRegistry(cwd, catalog).map((entry, index) => ({
		...entry,
		typeName: `PiToolArgs_${identifierPart(entry.provider)}_${identifierPart(entry.name)}_${index}`,
	}))

const toolRequiresArgs = (definition: CapturedToolDefinition): boolean => {
	const required = (definition.parameters as { required?: unknown }).required
	return Array.isArray(required) && required.length > 0
}

const toolSchemaEntries = (cwd: string, catalog: ToolCatalog) =>
	Object.fromEntries(
		toolDeclarationEntries(cwd, catalog).map(({ ref, provider, name, definition }) => [
			ref,
			{
				ref,
				provider,
				name,
				label: definition.label,
				description: guestToolDescription(name, definition.description),
				promptSnippet: definition.promptSnippet,
				argsSchema: definition.parameters,
				resultSchema: toolResultSchema,
			},
		]),
	) as Record<string, unknown>

const guestRuntimeMetadata = (cwd: string, catalog: ToolCatalog): string => {
	const entries = toolDeclarationEntries(cwd, catalog)
	return JSON.stringify({
		schemas: toolSchemaEntries(cwd, catalog),
		providers: [
			{ name: "pi", description: "Pi built-in coding tools" },
			{ name: "extensions", description: "Captured registered Pi extension tools" },
		],
		refsByProvider: {
			pi: entries.filter((entry) => entry.provider === "pi").map((entry) => entry.ref),
			extensions: entries.filter((entry) => entry.provider === "extensions").map((entry) => entry.ref),
		},
	})
}

const toolMethodDeclaration = (entry: ToolDeclarationEntry): string => {
	const description =
		schemaDescription(entry.definition.parameters) ?? guestToolDescription(entry.name, entry.definition.description)
	const optionalArgs = !toolRequiresArgs(entry.definition)
	return `${commentForDescription(description, "  ")}\n  ${JSON.stringify(entry.name)}(args${optionalArgs ? "?" : ""}: ${entry.typeName}): Promise<PiToolResult>;`
}

const guestDeclarations = (cwd: string, catalog: ToolCatalog): string => {
	const entries = toolDeclarationEntries(cwd, catalog)
	const piEntries = entries.filter((entry) => entry.provider === "pi")
	const extensionEntries = entries.filter((entry) => entry.provider === "extensions")
	const typeAliases = entries
		.map(({ typeName, definition }) => {
			const description = schemaDescription(definition.parameters)
			const alias = `type ${typeName} = ${typeboxToTypeScript(definition.parameters)};`
			return description ? `${commentForDescription(description)}\n${alias}` : alias
		})
		.join("\n\n")
	const argsByRef = entries.map(({ ref, typeName }) => `  ${JSON.stringify(ref)}: ${typeName};`).join("\n")
	const piMethods = piEntries.map(toolMethodDeclaration).join("\n")
	const extensionMethods = extensionEntries.map(toolMethodDeclaration).join("\n")
	const toolRefs = entries.map((entry) => JSON.stringify(entry.ref)).join(" | ") || "never"
	const optionalToolRefs =
		entries
			.filter((entry) => !toolRequiresArgs(entry.definition))
			.map((entry) => JSON.stringify(entry.ref))
			.join(" | ") || "never"
	return `
${typeAliases}

type PiToolRef = ${toolRefs};
type PiOptionalArgToolRef = ${optionalToolRefs};
type PiRequiredArgToolRef = Exclude<PiToolRef, PiOptionalArgToolRef>;
type PiToolProvider = "pi" | "extensions";
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type PiToolContentPart = ${typeboxToTypeScript(Type.Union([toolTextContentPartSchema, toolImageContentPartSchema]))};
type PiToolResult = ${typeboxToTypeScript(toolResultSchema)};

interface PiToolArgsByRef {
${argsByRef}
}

interface PiToolSchemaEntry {
  ref: PiToolRef;
  provider: PiToolProvider;
  name: string;
  label?: string;
  description?: string;
  promptSnippet?: string;
  argsSchema: JsonValue;
  resultSchema: JsonValue;
}

type PiToolSchemaMap = Record<PiToolRef, PiToolSchemaEntry>;
type PiToolHelpEntry = PiToolSchemaEntry;
type PiToolHelpMap = Record<PiToolRef, PiToolHelpEntry>;

interface PiApi {
${piMethods}
  /** Tagged-template sugar for pi.bash({ command }) with shell-escaped interpolations. */
  $(strings: TemplateStringsArray, ...values: unknown[]): Promise<PiToolResult>;
}

interface ExtensionsApi {
${extensionMethods || "  /** No extension tools are currently captured. */\n  readonly __empty?: never;"}
}

interface ToolsApi {
  providers(): Array<{ name: PiToolProvider; description: string }>;
  list(args?: { provider?: PiToolProvider; query?: string; limit?: number }): PiToolSchemaEntry[];
  schema(): PiToolSchemaMap;
  schema(ref: PiToolRef): PiToolSchemaEntry;
  help(): PiToolHelpMap;
  help(ref: PiToolRef): PiToolHelpEntry;
  call<Ref extends PiOptionalArgToolRef>(request: { ref: Ref; args?: PiToolArgsByRef[Ref] }): Promise<PiToolResult>;
  call<Ref extends PiRequiredArgToolRef>(request: { ref: Ref; args: PiToolArgsByRef[Ref] }): Promise<PiToolResult>;
}

declare const pi: Readonly<PiApi>;
declare const extensions: Readonly<ExtensionsApi>;
declare const tools: Readonly<ToolsApi>;
declare function print(...values: unknown[]): void;
declare const console: Readonly<{
  log(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
}>;
`
}

interface CodeModeTypeError {
	readonly line: number
	readonly column: number
	readonly message: string
}

interface CodeModeTypeCheckResult {
	readonly errors: readonly CodeModeTypeError[]
	readonly javascript?: string
}

const compilerOptions: ts.CompilerOptions = {
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.None,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	strict: true,
	noEmit: false,
	skipLibCheck: true,
	lib: ["lib.es2022.d.ts"],
}

const typeCheckCode = (code: string, declarations: string): CodeModeTypeCheckResult => {
	const guestFile = path.resolve("/__pi_code_mode_guest.ts")
	const declarationFile = path.resolve("/__pi_code_mode_globals.d.ts")
	const sourceText = `async function __piCodeModeMain() {\n${code}\n}\n`
	const host = ts.createCompilerHost(compilerOptions, true)
	const originalFileExists = host.fileExists.bind(host)
	const originalReadFile = host.readFile.bind(host)
	const originalGetSourceFile = host.getSourceFile.bind(host)
	host.fileExists = (fileName) => fileName === guestFile || fileName === declarationFile || originalFileExists(fileName)
	host.readFile = (fileName) => {
		if (fileName === guestFile) return sourceText
		if (fileName === declarationFile) return declarations
		return originalReadFile(fileName)
	}
	host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
		if (fileName === guestFile) return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true)
		if (fileName === declarationFile) return ts.createSourceFile(fileName, declarations, ts.ScriptTarget.ES2022, true)
		return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
	}
	const program = ts.createProgram({ rootNames: [declarationFile, guestFile], options: compilerOptions, host })
	const sourceFile = program.getSourceFile(guestFile)
	if (!sourceFile) return { errors: [{ line: 0, column: 0, message: "Unable to create code-mode source file" }] }
	const diagnostics = [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)]
	const errors = diagnostics.map((diagnostic) => {
		const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
		if (!diagnostic.file || diagnostic.start === undefined) return { line: 0, column: 0, message }
		const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
		return { line: Math.max(1, position.line), column: position.character + 1, message }
	})
	if (errors.length > 0) return { errors }

	let javascript: string | undefined
	program.emit(sourceFile, (fileName, content) => {
		if (fileName.endsWith(".js")) javascript = content
	})
	return { errors: [], ...(javascript ? { javascript } : {}) }
}

const sandboxSource = (javascript: string, metadataJson: string): string => `
const __codeModeCall = async (ref, args) => {
  const response = JSON.parse(await __pi_call(JSON.stringify({ ref, args: args ?? {} })));
  if (response.status === "ok") return response.value;
  throw new Error(response.ref + " failed during " + response.stage + ": " + response.error);
};
const __metadata = JSON.parse(${JSON.stringify(metadataJson)});
const __callRef = (ref, args) => {
  if (typeof ref !== "string") throw new Error("tools.call ref must be a string");
  if (!Object.prototype.hasOwnProperty.call(__metadata.schemas, ref)) throw new Error("Unknown tool ref for tools.call: " + ref);
  return __codeModeCall(ref, args);
};
const __toolNamespace = (provider) => {
  const target = {};
  for (const ref of __metadata.refsByProvider[provider] ?? []) {
    const entry = __metadata.schemas[ref];
    Object.defineProperty(target, entry.name, {
      value: (args) => __callRef(ref, args),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(target);
};
const __clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const __lookup = (record, kind, ref) => {
  if (ref === undefined) return __clone(record);
  if (typeof ref !== "string") throw new Error("tools." + kind + " ref must be a string");
  if (!Object.prototype.hasOwnProperty.call(record, ref)) throw new Error("Unknown tool ref for tools." + kind + ": " + ref);
  return __clone(record[ref]);
};
const __listTools = (args) => {
  const options = args ?? {};
  if (typeof options !== "object" || Array.isArray(options)) throw new Error("tools.list args must be an object");
  let values = Object.values(__metadata.schemas);
  if (options.provider !== undefined) values = values.filter((entry) => entry.provider === options.provider);
  if (typeof options.query === "string" && options.query.trim()) {
    const query = options.query.toLowerCase();
    values = values.filter((entry) => JSON.stringify(entry).toLowerCase().includes(query));
  }
  if (typeof options.limit === "number") values = values.slice(0, Math.max(0, Math.floor(options.limit)));
  return __clone(values);
};
const __shellEscape = (value) => {
  const text = String(value);
  if (text.length > 0 && /^[A-Za-z0-9_\\/:=.,+@%-]+$/.test(text)) return text;
  return "'" + text.replace(/'/g, "'\\''") + "'";
};
const __bashTemplate = (strings, ...values) => {
  let command = "";
  for (let i = 0; i < strings.raw.length; i++) {
    command += strings.raw[i];
    if (i < values.length) command += __shellEscape(values[i]);
  }
  return __codeModeCall("pi.bash", { command });
};
const __formatPrintValue = (value) => {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
};
delete globalThis.process;
delete globalThis.require;
delete globalThis.module;
delete globalThis.exports;
globalThis.pi = Object.freeze({
  read: (args) => __callRef("pi.read", args),
  bash: (args) => __callRef("pi.bash", args),
  edit: (args) => __callRef("pi.edit", args),
  write: (args) => __callRef("pi.write", args),
  grep: (args) => __callRef("pi.grep", args),
  find: (args) => __callRef("pi.find", args),
  ls: (args) => __callRef("pi.ls", args),
  $: __bashTemplate,
});
globalThis.extensions = __toolNamespace("extensions");
globalThis.tools = Object.freeze({
  providers: () => __clone(__metadata.providers),
  list: __listTools,
  schema: (ref) => __lookup(__metadata.schemas, "schema", ref),
  help: (ref) => __lookup(__metadata.schemas, "help", ref),
  call: (request) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("tools.call request must be an object");
    return __callRef(request.ref, request.args);
  },
});
globalThis.print = (...values) => __print(values.map(__formatPrintValue).join(" "));
globalThis.console = Object.freeze({ log: globalThis.print, error: globalThis.print, warn: globalThis.print });
${javascript}
__piCodeModeMain();
`

const stageOf = (error: unknown): FailureStage => (error instanceof CodeModeBoundaryError ? error.stage : "invoke")

const refOf = (call: HostCall | undefined): PiToolRef | "unknown" => call?.ref ?? "unknown"

const refFromRawEnvelope = (rawEnvelope: string): PiToolRef | "unknown" => {
	try {
		const decoded = JSON.parse(rawEnvelope) as { ref?: unknown }
		if (typeof decoded.ref !== "string" || !parseToolRef(decoded.ref)) return "unknown"
		return decoded.ref as PiToolRef
	} catch {
		return "unknown"
	}
}

const runInQuickJs = async (input: {
	javascript: string
	metadataJson: string
	timeoutMs: number
	memoryLimitBytes: number
	context: ExtensionContext
	toolCallId: string
	catalog: ToolCatalog
	onPartial?: (snapshot: {
		prints: readonly string[]
		operations: readonly CodeExecRenderOperation[]
	}) => void
}): Promise<{ result: unknown; prints: string[]; operations: TraceOperation[] }> => {
	const started = Date.now()
	let sequence = 0
	const prints: string[] = []
	const operations: TraceOperation[] = []
	const renderOperations = new Map<number, CodeExecRenderOperation>()
	const renderOperationSnapshots = (): CodeExecRenderOperation[] =>
		[...renderOperations.values()].sort((left, right) => left.sequence - right.sequence)
	const emitPartial = (): void => input.onPartial?.({ prints: [...prints], operations: renderOperationSnapshots() })
	const setRenderOperation = (operation: CodeExecRenderOperation): void => {
		renderOperations.set(
			operation.sequence,
			assertTypeBox<CodeExecRenderOperation>(renderOperationSchema, operation, "Invalid code-mode render operation"),
		)
		emitPartial()
	}
	const vm = (await quickJsModule()).newContext()
	const runtime = vm.runtime
	runtime.setMemoryLimit(input.memoryLimitBytes)
	runtime.setInterruptHandler(() => Date.now() - started > input.timeoutMs)
	const hostTasks = new Set<Promise<void>>()
	try {
		const callHandle = vm.newFunction("__pi_call", (rawEnvelopeHandle) => {
			const rawEnvelope = vm.getString(rawEnvelopeHandle)
			const promise = vm.newPromise()
			const opSequence = sequence++
			const opStartedAt = new Date().toISOString()
			let call: HostCall | undefined
			let toolCallId = `${input.toolCallId}:code:${opSequence}:unknown`
			setRenderOperation({
				sequence: opSequence,
				toolCallId,
				ref: refFromRawEnvelope(rawEnvelope),
				outcome: "running",
				startedAt: opStartedAt,
				rawEnvelope: rawEnvelopeForUi(rawEnvelope),
			})
			const task = (async () => {
				try {
					call = decodeHostCall(rawEnvelope, input.context.cwd, input.catalog)
					const entry = toolDefinitionForRef(input.context.cwd, input.catalog, call.ref)
					if (!entry) throw new CodeModeBoundaryError("guard", `code-mode does not expose ${call.ref}`)
					toolCallId = `${input.toolCallId}:code:${opSequence}:${call.ref}`
					setRenderOperation({
						sequence: opSequence,
						toolCallId,
						ref: call.ref,
						outcome: "running",
						startedAt: opStartedAt,
						args: sanitizeForUi(call.args),
					})
					const response = validateHostResponse(
						await invokePiTool({
							call,
							outerToolCallId: input.toolCallId,
							sequence: opSequence,
							context: input.context,
							catalog: input.catalog,
							signal: input.context.signal,
							onUpdate: (partialResult) => {
								try {
									const partialValue = assertTypeBox<PiToolResult>(
										toolResultSchema,
										sanitizeForUi(toolResultValue(partialResult)),
										"Invalid nested partial result",
									)
									setRenderOperation({
										sequence: opSequence,
										toolCallId,
										ref: call?.ref ?? refFromRawEnvelope(rawEnvelope),
										outcome: "running",
										startedAt: opStartedAt,
										...(call ? { args: sanitizeForUi(call.args) } : { rawEnvelope: rawEnvelopeForUi(rawEnvelope) }),
										result: partialValue,
									})
								} catch {
									// Ignore malformed nested partials; the final tool result still gets validated.
								}
							},
						}),
					)
					const operation: TraceOperation = {
						sequence: opSequence,
						toolCallId,
						startedAt: opStartedAt,
						endedAt: new Date().toISOString(),
						outcome: "ok",
						call,
						response: response as HostOkResponse,
					}
					operations.push(operation)
					setRenderOperation(renderOperationFromTrace(operation))
					const responseHandle = vm.newString(JSON.stringify(response))
					promise.resolve(responseHandle)
					responseHandle.dispose()
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					const stage = stageOf(error)
					const ref = call ? refOf(call) : refFromRawEnvelope(rawEnvelope)
					const failure = errorResponse(ref, stage, message)
					const operation: TraceOperation = {
						sequence: opSequence,
						toolCallId,
						startedAt: opStartedAt,
						endedAt: new Date().toISOString(),
						outcome: "error",
						stage,
						ref,
						error: message,
						response: failure,
						...(call ? { call } : { rawEnvelope }),
					}
					operations.push(operation)
					setRenderOperation(renderOperationFromTrace(operation))
					const responseHandle = vm.newString(JSON.stringify(failure))
					promise.resolve(responseHandle)
					responseHandle.dispose()
				} finally {
					runtime.executePendingJobs()
				}
			})()
			hostTasks.add(task)
			void task.finally(() => hostTasks.delete(task))
			return promise.handle
		})
		callHandle.consume((handle) => vm.setProp(vm.global, "__pi_call", handle))

		const printHandle = vm.newFunction("__print", (textHandle) => {
			const text = vm.getString(textHandle)
			prints.push(text)
			emitPartial()
			return vm.undefined
		})
		printHandle.consume((handle) => vm.setProp(vm.global, "__print", handle))

		const evaluation = vm.evalCode(sandboxSource(input.javascript, input.metadataJson), "code-mode.js")
		try {
			const quickJsErrorMessage = (handle: Parameters<typeof vm.dump>[0]): string => {
				const dumped = vm.dump(handle)
				if (dumped && typeof dumped === "object" && "message" in dumped) return String(dumped.message)
				return String(dumped)
			}
			if (evaluation.error) throw new Error(quickJsErrorMessage(evaluation.error))
			while (true) {
				runtime.executePendingJobs()
				const state = vm.getPromiseState(evaluation.value)
				if (state.type === "fulfilled") {
					try {
						return { result: vm.dump(state.value), prints, operations }
					} finally {
						if (state.notAPromise !== true && state.value.alive) state.value.dispose()
					}
				}
				if (state.type === "rejected") {
					try {
						throw new Error(quickJsErrorMessage(state.error))
					} finally {
						if (state.error.alive) state.error.dispose()
					}
				}
				if (Date.now() - started > input.timeoutMs) throw new Error(`Execution timed out after ${input.timeoutMs}ms`)
				await new Promise((resolve) => setTimeout(resolve, 5))
			}
		} catch (error) {
			throw new CodeModeRuntimeError(error instanceof Error ? error.message : String(error), prints, operations)
		} finally {
			if (evaluation.error) evaluation.error.dispose()
			else if (evaluation.value.alive) evaluation.value.dispose()
		}
	} finally {
		if (hostTasks.size > 0) await Promise.allSettled(hostTasks)
		vm.dispose()
	}
}

const traceSchemaFor = (cwd: string, catalog: ToolCatalog): TSchema => {
	const callSchema = hostCallSchema(cwd, catalog)
	const traceOperationSchema = Type.Union([
		Type.Object({
			sequence: Type.Number(),
			toolCallId: Type.String(),
			startedAt: Type.String(),
			endedAt: Type.String(),
			outcome: Type.Literal("ok"),
			call: callSchema,
			response: hostOkResponseSchema,
		}),
		Type.Object({
			sequence: Type.Number(),
			toolCallId: Type.String(),
			startedAt: Type.String(),
			endedAt: Type.String(),
			outcome: Type.Literal("error"),
			stage: Type.Union([
				Type.Literal("decode"),
				Type.Literal("validate"),
				Type.Literal("guard"),
				Type.Literal("lifecycle"),
				Type.Literal("invoke"),
				Type.Literal("result_encode"),
			]),
			ref: hostErrorResponseSchema.properties.ref,
			error: Type.String(),
			response: hostErrorResponseSchema,
			call: Type.Optional(callSchema),
			rawEnvelope: Type.Optional(Type.String()),
		}),
	])
	return Type.Object({
		kind: Type.Literal(TRACE_KIND),
		version: Type.Literal(TRACE_VERSION),
		executionId: Type.String(),
		toolCallId: Type.String(),
		cwd: Type.String(),
		startedAt: Type.String(),
		endedAt: Type.String(),
		success: Type.Boolean(),
		codeSha256: Type.String(),
		prints: Type.Array(Type.String()),
		operations: Type.Array(traceOperationSchema),
		result: Type.Optional(Type.Unknown()),
		error: Type.Optional(Type.String()),
	})
}

const validateTrace = (schema: TSchema, trace: CodeModeTraceV1): CodeModeTraceV1 =>
	assertTypeBox<CodeModeTraceV1>(schema, trace, "Invalid code-mode trace")

const sanitizeForUi = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(sanitizeForUi)
	if (!value || typeof value !== "object") return value
	const record = value as Record<string, unknown>
	if (record.type === "image" && typeof record.mimeType === "string") {
		return { type: "image", mimeType: record.mimeType, data: "<base64 omitted>" }
	}
	return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, sanitizeForUi(child)]))
}

const compactValue = (value: unknown): string => {
	if (typeof value === "string") return value
	if (value === undefined) return ""
	try {
		return JSON.stringify(sanitizeForUi(value))
	} catch {
		return String(value)
	}
}

const rawEnvelopeForUi = (rawEnvelope: string): unknown => {
	try {
		return sanitizeForUi(JSON.parse(rawEnvelope))
	} catch {
		return rawEnvelope
	}
}

const renderOperationFromTrace = (operation: TraceOperation): CodeExecRenderOperation => {
	if (operation.outcome === "ok") {
		return assertTypeBox<CodeExecRenderOperation>(
			renderOperationSchema,
			{
				sequence: operation.sequence,
				toolCallId: operation.toolCallId,
				ref: operation.call.ref,
				outcome: operation.outcome,
				startedAt: operation.startedAt,
				endedAt: operation.endedAt,
				args: sanitizeForUi(operation.call.args),
				result: sanitizeForUi(operation.response.value),
			},
			"Invalid code-mode render operation",
		)
	}
	return assertTypeBox<CodeExecRenderOperation>(
		renderOperationSchema,
		{
			sequence: operation.sequence,
			toolCallId: operation.toolCallId,
			ref: operation.ref,
			outcome: operation.outcome,
			startedAt: operation.startedAt,
			endedAt: operation.endedAt,
			...(operation.call ? { args: sanitizeForUi(operation.call.args) } : {}),
			...(operation.rawEnvelope ? { rawEnvelope: rawEnvelopeForUi(operation.rawEnvelope) } : {}),
			stage: operation.stage,
			error: operation.error,
		},
		"Invalid code-mode render operation",
	)
}

const prettyValue = (value: unknown): string => {
	if (typeof value === "string") return value
	if (value === undefined) return ""
	try {
		return JSON.stringify(sanitizeForUi(value), null, 2)
	} catch {
		return String(value)
	}
}

const markdownFence = (language: string, text: string): string => {
	const ticks = text.match(/`+/g)?.reduce((max, ticks) => Math.max(max, ticks.length), 3) ?? 3
	const fence = "`".repeat(ticks + 1)
	return `${fence}${language}\n${text}\n${fence}`
}

const truncateLines = (text: string, expanded: boolean, maxLines: number): string => {
	const lines = text.split("\n")
	if (expanded || lines.length <= maxLines) return text
	const remaining = lines.length - maxLines
	return `${lines.slice(0, maxLines).join("\n")}\n// … ${remaining} more lines hidden; expand tool output for full text`
}

const isPiToolResult = (value: unknown): value is PiToolResult =>
	Boolean(value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content))

const countLabel = (count: number, singular: string): string => `${count} ${count === 1 ? singular : `${singular}s`}`

const toolResultTextParts = (value: PiToolResult): string[] =>
	value.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text.trim())
		.filter(Boolean)

const toolResultText = (value: PiToolResult): string => toolResultTextParts(value).join("\n\n")

const inlineCode = (value: string): string => `\`${value.replaceAll("`", "\\`")}\``

const formatMultimodalToolResult = (value: PiToolResult, expanded: boolean): string => {
	const [headline, ...captions] = toolResultTextParts(value)
	const lines: string[] = []
	if (headline) lines.push(truncateLines(headline, expanded, 6))
	const limit = expanded ? captions.length : Math.min(captions.length, 8)
	const shown = captions.slice(0, limit)
	if (shown.length > 0) {
		if (lines.length > 0) lines.push("")
		lines.push(...shown.map((caption) => `- ${caption.includes("\n") ? caption : inlineCode(caption)}`))
	}
	if (!expanded && captions.length > shown.length) {
		lines.push(`- … ${countLabel(captions.length - shown.length, "more item")}`)
	}
	return lines.join("\n") || "(images)"
}

const formatToolResult = (value: PiToolResult, expanded: boolean): string => {
	const imageCount = value.content.filter((part) => part.type === "image").length
	if (imageCount > 0) return formatMultimodalToolResult(value, expanded)
	const text = toolResultText(value)
	return text ? markdownFence("text", truncateLines(text, expanded, 8)) : "(no result)"
}

const shortJson = (value: unknown, maxChars = 180): string => {
	const text = compactValue(value)
	return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const compactObject = (entries: readonly (readonly [string, unknown])[]): Record<string, unknown> =>
	Object.fromEntries(
		entries.filter((entry): entry is readonly [string, NonNullable<unknown>] => entry[1] !== undefined),
	)

const summarizedArgsForRef = (ref: string, args: unknown): unknown => {
	const record = asRecord(args)
	if (!record) return args
	switch (ref) {
		case "pi.bash":
			return compactObject([["command", record.command]])
		case "pi.read":
			return compactObject([
				["path", record.path],
				["offset", record.offset],
				["limit", record.limit],
			])
		case "pi.edit":
			return compactObject([
				["path", record.path],
				["edits", Array.isArray(record.edits) ? countLabel(record.edits.length, "edit") : record.edits],
			])
		case "pi.write":
			return compactObject([
				["path", record.path],
				["content", typeof record.content === "string" ? `${record.content.length} chars` : record.content],
			])
		case "pi.grep":
			return compactObject([
				["pattern", record.pattern],
				["path", record.path],
				["glob", record.glob],
			])
		case "pi.find":
			return compactObject([
				["pattern", record.pattern],
				["path", record.path],
			])
		case "pi.ls":
			return compactObject([["path", record.path]])
		default:
			return record
	}
}

const operationCallText = (operation: Pick<CodeExecRenderOperation, "ref" | "args" | "rawEnvelope">): string => {
	const rawRecord = asRecord(operation.rawEnvelope)
	const ref =
		operation.ref !== "unknown" ? operation.ref : typeof rawRecord?.ref === "string" ? rawRecord.ref : operation.ref
	const previewArgs =
		operation.args !== undefined
			? operation.args
			: rawRecord && Object.hasOwn(rawRecord, "args")
				? rawRecord.args
				: operation.rawEnvelope
	return previewArgs === undefined ? ref : `${ref}(${shortJson(summarizedArgsForRef(ref, previewArgs), 140)})`
}

const operationHeadline = (operation: CodeExecRenderOperation): string => {
	const glyph = operation.outcome === "ok" ? "✓" : operation.outcome === "error" ? "✗" : "◌"
	const stage = operation.outcome === "error" && operation.stage ? ` [${operation.stage}]` : ""
	return `${glyph} step ${operation.sequence + 1}: ${inlineCode(operationCallText(operation))}${stage}`
}

const operationFallbackMarkdown = (operation: CodeExecRenderOperation, expanded: boolean): string => {
	const lines = [operationHeadline(operation)]
	if (operation.outcome === "error" && operation.error) lines.push(`  ${operation.error}`)
	if (expanded && operation.args !== undefined) {
		lines.push("", "args", "", markdownFence("json", truncateLines(prettyValue(operation.args), true, 20)))
	}
	if (expanded && operation.rawEnvelope !== undefined) {
		lines.push("", "raw call", "", markdownFence("json", truncateLines(prettyValue(operation.rawEnvelope), true, 20)))
	}
	return lines.join("\n")
}

const nestedSlot = (state: CodeExecRendererState, sequence: number): NestedRendererSlot => {
	state.nestedSlots ??= new Map()
	let slot = state.nestedSlots.get(sequence)
	if (!slot) {
		slot = { state: {} }
		state.nestedSlots.set(sequence, slot)
	}
	return slot
}

const renderNativeOperation = (input: {
	operation: CodeExecRenderOperation
	definition: CapturedToolDefinition
	theme: Theme
	expanded: boolean
	cwd: string
	outerContext: { invalidate: () => void; showImages: boolean }
	slot: NestedRendererSlot
}): Component => {
	const component = new Container()
	const args = input.operation.args as Record<string, unknown> | undefined
	const renderContext = (lastComponent: Component | undefined) => ({
		args: args ?? {},
		toolCallId: input.operation.toolCallId,
		invalidate: input.outerContext.invalidate,
		lastComponent,
		state: input.slot.state,
		cwd: input.cwd,
		executionStarted: true,
		argsComplete: true,
		isPartial: input.operation.outcome === "running",
		expanded: input.expanded,
		showImages: input.outerContext.showImages,
		isError: input.operation.outcome === "error",
	})
	try {
		if (input.definition.renderCall && args) {
			input.slot.call = input.definition.renderCall(args, input.theme, renderContext(input.slot.call))
			component.addChild(input.slot.call)
		} else {
			component.addChild(new Markdown(operationFallbackMarkdown(input.operation, false), 0, 0, getMarkdownTheme()))
		}
		if (input.operation.result && input.definition.renderResult) {
			input.slot.result = input.definition.renderResult(
				{ content: input.operation.result.content, details: input.operation.result.details },
				{ expanded: input.expanded, isPartial: input.operation.outcome === "running" },
				input.theme,
				renderContext(input.slot.result),
			)
			component.addChild(input.slot.result)
		} else if (input.operation.outcome === "running") {
			component.addChild(new Text(input.theme.fg("dim", "running…"), 0, 0))
		} else if (input.operation.outcome === "error" && input.operation.error) {
			component.addChild(new Text(input.theme.fg("error", input.operation.error), 0, 0))
		}
		return component
	} catch {
		const fallback = new Container()
		fallback.addChild(
			new Markdown(operationFallbackMarkdown(input.operation, input.expanded), 0, 0, getMarkdownTheme()),
		)
		return fallback
	}
}

const renderOperations = (input: {
	operations: readonly CodeExecRenderOperation[]
	catalog: ToolCatalog
	theme: Theme
	expanded: boolean
	cwd: string
	outerContext: { invalidate: () => void; showImages: boolean; state: CodeExecRendererState }
}): Component | undefined => {
	if (input.operations.length === 0) return undefined
	const component = new Container()
	component.addChild(new Markdown("**calls**", 0, 0, getMarkdownTheme()))
	const shown = input.expanded ? input.operations : input.operations.slice(0, 6)
	for (const operation of shown) {
		component.addChild(new Spacer(1))
		const definition = toolDefinitionForRef(input.cwd, input.catalog, operation.ref)?.definition
		if (definition) {
			component.addChild(
				renderNativeOperation({
					operation,
					definition,
					theme: input.theme,
					expanded: input.expanded,
					cwd: input.cwd,
					outerContext: input.outerContext,
					slot: nestedSlot(input.outerContext.state, operation.sequence),
				}),
			)
		} else {
			component.addChild(new Markdown(operationFallbackMarkdown(operation, input.expanded), 0, 0, getMarkdownTheme()))
		}
	}
	if (!input.expanded && input.operations.length > shown.length) {
		component.addChild(new Spacer(1))
		component.addChild(
			new Markdown(
				`… ${countLabel(input.operations.length - shown.length, "more call")}; expand to show all`,
				0,
				0,
				getMarkdownTheme(),
			),
		)
	}
	return component
}

const imagePartsFromValue = (value: unknown): ToolImageContentPart[] => {
	if (!isPiToolResult(value)) return []
	return value.content.filter((part): part is ToolImageContentPart => part.type === "image")
}

const imagesFromRun = (result: unknown, operations: readonly TraceOperation[]): ToolImageContentPart[] => {
	const images = [
		...imagePartsFromValue(result),
		...operations.flatMap((operation) =>
			operation.outcome === "ok" ? imagePartsFromValue(operation.response.value) : [],
		),
	]
	const seen = new Set<string>()
	return images.filter((image) => {
		const key = `${image.mimeType}:${image.data}`
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}

const formatCodeCallMarkdown = (args: unknown, expanded: boolean): string => {
	const code =
		typeof (args as { code?: unknown } | undefined)?.code === "string"
			? (args as CodeExecInput).code
			: compactValue(args)
	const shown = truncateLines(code, expanded, 10)
	return ["**code_exec**", "", markdownFence("ts", shown)].join("\n")
}

const formatUiResultMarkdown = (details: CodeExecResultDetails, expanded: boolean): string => {
	const imageCount =
		details.imageCount ?? (isPiToolResult(details.result) ? imagePartsFromValue(details.result).length : 0)
	const title =
		details.status === "running" ? "code_exec running" : details.success ? "code_exec completed" : "code_exec failed"
	const headerParts = [`**${title}**`, countLabel(details.operationCount, "operation")]
	if (imageCount > 0) headerParts.push(countLabel(imageCount, "image"))
	const lines = [headerParts.join(" · ")]
	if (details.status !== "running" && !details.success && details.error) {
		lines.push("", markdownFence("text", truncateLines(details.error, expanded, 8)))
	}
	if (details.prints.length > 0) {
		lines.push("", "**prints**", "", markdownFence("text", truncateLines(details.prints.join("\n"), expanded, 8)))
	}
	if (details.status !== "running" && details.result !== undefined) {
		lines.push("", "**result**", "")
		if (isPiToolResult(details.result)) {
			lines.push(formatToolResult(details.result, expanded))
		} else {
			lines.push(
				markdownFence(
					typeof details.result === "string" ? "text" : "json",
					truncateLines(prettyValue(details.result), expanded, 14),
				),
			)
		}
	}
	return lines.join("\n")
}

const summarizeTrace = (trace: CodeModeTraceV1): string => {
	if (trace.success) {
		const parts: string[] = []
		if (trace.prints.length > 0) parts.push(trace.prints.join("\n"))
		if (isPiToolResult(trace.result))
			parts.push(
				toolResultText(trace.result) || `${countLabel(imagePartsFromValue(trace.result).length, "image")} returned`,
			)
		else if (trace.result !== undefined) parts.push(compactValue(trace.result))
		return parts.filter(Boolean).join("\n") || "completed"
	}

	const failed = trace.operations.filter((op) => op.outcome === "error")
	const lines = ["code_exec failed"]
	if (failed.length > 0) {
		lines.push(
			failed
				.map((op) => {
					const operation = renderOperationFromTrace(op)
					return `- step ${operation.sequence + 1}: ${operationCallText(operation)} [${op.stage}]: ${op.error}`
				})
				.join("\n"),
		)
	} else if (trace.error) lines.push(trace.error)
	return lines.join("\n")
}

const codeModeTool = (pi: ExtensionAPI, catalog: ToolCatalog) =>
	defineTool({
		name: "code_exec",
		label: "Code Exec",
		description:
			"Run a small TypeScript/JavaScript program in a QuickJS sandbox. The program can call exposed Pi builtins and registered extension tools through the code-mode API.",
		promptSnippet:
			"Run a small TypeScript/JavaScript program. API: pi.* for built-in tools, extensions.* for registered extension tools, tools.* for discovery/schema/help/dynamic calls.",
		promptGuidelines: [
			"Use code_exec for multi-step mechanical tool workflows; await every tool call.",
			"Inside code_exec, use pi.read/pi.bash/pi.edit/pi.write/pi.grep/pi.find/pi.ls for Pi built-in coding tools only.",
			"Use extensions.<toolName>(args) for registered extension tools, e.g. extensions.web_search({ query: '...' }) or extensions.task({ action: 'list' }).",
			"Use tools.list({ provider: 'extensions' }), tools.help('extensions.<toolName>'), and tools.schema('extensions.<toolName>') to discover extension tools and their TypeBox argument schemas.",
			"Use tools.call({ ref: 'extensions.<toolName>', args }) or tools.call({ ref: 'pi.read', args }) only when the ref is computed dynamically.",
			"Tool refs are explicit strings like 'pi.read' and 'extensions.web_search'; there is no pi.tool, pi.call, pi.schema, or pi.help API.",
			"All tool calls return PiToolResult: { content: [{ type: 'text', text } | { type: 'image', data, mimeType }], details? }. Do not assume stdout/stderr/exitCode/output fields for bash.",
			"Prefer result.content for program logic. result.details is tool-specific UI/debug metadata and is typed opaque; narrow or cast before reading detail fields.",
			"Return a compact final value from the code body when useful; intermediate nested tool calls are shown in the code_exec UI audit.",
		],
		parameters: codeExecSchema,
		executionMode: "sequential",
		renderCall(args, _theme, context) {
			const component = (context.lastComponent as Container | undefined) ?? new Container()
			component.clear()
			component.addChild(new Markdown(formatCodeCallMarkdown(args, context.expanded), 0, 0, getMarkdownTheme()))
			return component
		},
		async execute(toolCallId, params: CodeExecInput, _signal, onUpdate, context) {
			const executionId = crypto.randomUUID()
			const startedAt = new Date().toISOString()
			let success = false
			let result: unknown
			let error: string | undefined
			let prints: string[] = []
			let operations: TraceOperation[] = []
			const emitPartial = (snapshot: {
				prints: readonly string[]
				operations: readonly CodeExecRenderOperation[]
			}): void => {
				if (!onUpdate) return
				const details = assertTypeBox<CodeExecResultDetails>(
					resultDetailsSchema,
					{
						kind: RESULT_KIND,
						version: TRACE_VERSION,
						executionId,
						traceEntryType: TRACE_ENTRY_TYPE,
						success: false,
						status: "running",
						prints: snapshot.prints,
						operationCount: snapshot.operations.length,
						operations: snapshot.operations,
					},
					"Invalid code-mode partial result details",
				)
				onUpdate({ content: [{ type: "text", text: "running" }], details })
			}
			emitPartial({ prints, operations: [] })
			try {
				const checked = typeCheckCode(params.code, guestDeclarations(context.cwd, catalog))
				if (checked.errors.length > 0) {
					const diagnostics = checked.errors
						.map((diagnostic) => `${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`)
						.join("\n")
					throw new Error(`Type checking failed:\n${diagnostics}`)
				}
				if (!checked.javascript) throw new Error("TypeScript did not emit JavaScript")
				const run = await runInQuickJs({
					javascript: checked.javascript,
					metadataJson: guestRuntimeMetadata(context.cwd, catalog),
					timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
					memoryLimitBytes: params.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES,
					context,
					toolCallId,
					catalog,
					onPartial: emitPartial,
				})
				result = run.result
				prints = run.prints
				operations = run.operations
				success = true
			} catch (cause) {
				if (cause instanceof CodeModeRuntimeError) {
					prints = [...cause.prints]
					operations = [...cause.operations]
				}
				error = cause instanceof Error ? cause.message : String(cause)
			}

			operations = [...operations].sort((left, right) => left.sequence - right.sequence)
			const trace = validateTrace(traceSchemaFor(context.cwd, catalog), {
				kind: TRACE_KIND,
				version: TRACE_VERSION,
				executionId,
				toolCallId,
				cwd: context.cwd,
				startedAt,
				endedAt: new Date().toISOString(),
				success,
				codeSha256: crypto.createHash("sha256").update(params.code).digest("hex"),
				prints,
				operations,
				...(result !== undefined ? { result } : {}),
				...(error ? { error } : {}),
			})
			pi.appendEntry<CodeModeTraceV1>(TRACE_ENTRY_TYPE, trace)
			const summary = summarizeTrace(trace)
			const images = imagesFromRun(result, operations)
			const details = assertTypeBox<CodeExecResultDetails>(
				resultDetailsSchema,
				{
					kind: RESULT_KIND,
					version: TRACE_VERSION,
					executionId,
					traceEntryType: TRACE_ENTRY_TYPE,
					success,
					status: success ? "completed" : "failed",
					...(result !== undefined ? { result: sanitizeForUi(result) } : {}),
					prints,
					operationCount: operations.length,
					...(images.length > 0 ? { imageCount: images.length } : {}),
					operations: operations.map(renderOperationFromTrace),
					...(error ? { error } : {}),
				},
				"Invalid code-mode result details",
			)
			return { content: [{ type: "text", text: summary }, ...images], details, ...(success ? {} : { isError: true }) }
		},
		renderResult(result, options, theme, context) {
			const details = result.details as CodeExecResultDetails | undefined
			const component = (context.lastComponent as Container | undefined) ?? new Container()
			component.clear()
			const markdown =
				details?.kind === RESULT_KIND ? formatUiResultMarkdown(details, options.expanded) : textContent(result.content)
			component.addChild(new Markdown(markdown, 0, 0, getMarkdownTheme()))
			if (details?.kind === RESULT_KIND && details.operations) {
				const operationsComponent = renderOperations({
					operations: details.operations,
					catalog,
					theme,
					expanded: options.expanded,
					cwd: context.cwd,
					outerContext: {
						invalidate: context.invalidate,
						showImages: context.showImages,
						state: context.state as CodeExecRendererState,
					},
				})
				if (operationsComponent) {
					component.addChild(new Spacer(1))
					component.addChild(operationsComponent)
				}
			}
			return component
		},
	})

export default async function codeMode(pi: ExtensionAPI): Promise<void> {
	const catalog = new InMemoryToolCatalog()
	const tool = codeModeTool(pi, catalog)
	const disposeCapture = await installToolCapture(tool, catalog)
	pi.on("session_shutdown", () => disposeCapture())
	pi.registerTool(tool)
}

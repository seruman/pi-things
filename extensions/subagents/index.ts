import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
	type AssistantMessage,
	type JsonValue,
	type Static,
	StringEnum,
	type TextContent,
	Type,
	type Usage,
} from "@earendil-works/pi-ai"
import {
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent"
import { type SelectItem, SelectList } from "@earendil-works/pi-tui"
import { getChildPolicyArgs } from "../shell-leash/child-policy"
import { getPiInvocationParts } from "../split-fork"
import { installBridge } from "./bridge"
import type { ParentContext, ParentHost } from "./contracts"
import {
	type Exec,
	type RunState,
	closeBlock,
	effectiveRunState,
	newBlock,
	readProcess,
	runStates,
	showBlock,
} from "./rex"
import {
	type RunMetadata,
	enqueue,
	getRun,
	inboxPending,
	listRuns,
	normalizeRunName,
	prepareRun,
	readMetadata,
	removeRunDir,
	runDirectory,
	runDisplayName,
	thinkingLevels,
	updateMetadata,
	writeMetadata,
} from "./runs"
import { childUsage } from "./usage"

const EXCLUDED = ["codemode", "agent_spawn", "agent_send", "agent_wait", "agent_stop", "agent_list", "agent_rename"]

const READONLY = ["read", "grep", "find", "ls"]

const usageSchema = Type.Object({
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
	totalTokens: Type.Number(),
	reasoning: Type.Optional(Type.Number()),
	cacheWrite1h: Type.Optional(Type.Number()),
	cost: Type.Object({
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		total: Type.Number(),
	}),
})

const modelSchema = Type.Object({ provider: Type.String(), id: Type.String() })

const runResultSchema = Type.Object({
	handle: Type.String(),
	name: Type.Optional(Type.String()),
	blockId: Type.String(),
	sessionFile: Type.String(),
	status: Type.Union([Type.Literal("success"), Type.Literal("error"), Type.Literal("aborted")]),
	answer: Type.String(),
	model: modelSchema,
	cwd: Type.String(),
	usage: usageSchema,
	error: Type.Optional(Type.String()),
})

const backgroundSchema = Type.Object({
	handle: Type.String(),
	name: Type.Optional(Type.String()),
	blockId: Type.String(),
	sessionFile: Type.String(),
	cwd: Type.String(),
	model: modelSchema,
})

const spawnSchema = Type.Union([runResultSchema, backgroundSchema])

const handleSchema = Type.Object({ handle: Type.String() })

const listSchema = Type.Object({
	runs: Type.Array(
		Type.Object({
			handle: Type.String(),
			name: Type.Optional(Type.String()),
			blockId: Type.String(),
			sessionFile: Type.String(),
			cwd: Type.String(),
			model: modelSchema,
			thinking: StringEnum(thinkingLevels),
			state: StringEnum(runStates),
			error: Type.Optional(Type.String()),
		}),
	),
})

type RunResult = Static<typeof runResultSchema>

type BackgroundResult = Static<typeof backgroundSchema>

function toolResult<T extends JsonValue>(
	body: T,
	text: string,
	options?: { isError?: boolean; usage?: Usage },
): AgentToolResult<T> {
	const result: AgentToolResult<T> = {
		content: [{ type: "text", text }],
		details: body,
		structuredContent: body,
	}

	if (options?.isError) result.isError = true

	if (options?.usage) result.usage = options.usage

	return result
}

const nameParameter = Type.String({
	description: "Display name: a single line of 1 to 64 characters, trimmed. Handles remain the stable identifiers.",
})

const spawnParameters = Type.Object({
	prompt: Type.String({ minLength: 1 }),
	name: Type.Optional(nameParameter),
	cwd: Type.Optional(Type.String()),
	provider: Type.Optional(Type.String({ description: "Provider id. Defaults to the parent's provider." })),
	model: Type.Optional(
		Type.String({
			description: "Model id. Defaults to the parent's model. Set alongside provider for cross-provider use.",
		}),
	),
	thinkingLevel: Type.Optional(StringEnum(thinkingLevels)),
	tools: Type.Optional(Type.Union([Type.Literal("readonly"), Type.Array(Type.String())])),
	excludeTools: Type.Optional(Type.Array(Type.String())),
	noTools: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("builtin")])),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Return immediately instead of waiting for the initial turn. Successful completion leaves the child alive in either mode.",
		}),
	),
})

type SpawnParameters = Static<typeof spawnParameters>

function toolFlags(params: SpawnParameters): string[] {
	const tools = params.tools === "readonly" ? READONLY : params.tools
	const exclude = [...EXCLUDED, ...(params.excludeTools ?? [])]
	const args: string[] = []

	if (tools?.length) args.push("--tools", tools.join(","))
	args.push("--exclude-tools", exclude.join(","))

	if (params.noTools === "all") args.push("--no-tools")

	if (params.noTools === "builtin") args.push("--no-builtin-tools")

	return args
}

function launchCommand(run: Omit<RunMetadata, "blockId">, initial: string[] = []): string[] {
	return [
		"env",
		`PI_SUBAGENT_RUN_DIR=${runDirectory(run.handle)}`,
		...getPiInvocationParts(),
		// Load this bridge even when the installed package is older or cwd differs.
		"--extension",
		fileURLToPath(import.meta.url),
		"--session",
		run.sessionFile,
		"--provider",
		run.provider,
		"--model",
		run.model,
		"--thinking",
		run.thinking,
		...run.launchArgs,
		...initial,
	]
}

function assistantText(message: AssistantMessage): string {
	const text = message.content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim()

	return text || message.errorMessage || "(no response text)"
}

function isAssistantEntry(entry: SessionEntry): entry is SessionEntry & { type: "message"; message: AssistantMessage } {
	return entry.type === "message" && entry.message.role === "assistant"
}

function latestAssistant(session: SessionManager): AssistantMessage | undefined {
	return session.getBranch().findLast(isAssistantEntry)?.message
}

function resultOf(
	run: RunMetadata,
	status: RunResult["status"],
	answer: string,
	session: SessionManager,
	error?: string,
): RunResult {
	const result: RunResult = {
		handle: run.handle,
		blockId: run.blockId,
		sessionFile: run.sessionFile,
		status,
		answer,
		model: { provider: run.provider, id: run.model },
		cwd: run.cwd,
		usage: childUsage(session.getEntries()),
	}

	if (run.name !== undefined) result.name = run.name

	if (error) result.error = error

	return result
}

function outcome(run: RunMetadata, message: AssistantMessage, answer: string, session: SessionManager): RunResult {
	if (message.stopReason === "error") return resultOf(run, "error", answer, session, message.errorMessage)

	if (message.stopReason === "aborted") return resultOf(run, "aborted", answer, session)

	return resultOf(run, "success", answer, session)
}

async function settle(
	exec: Exec,
	initialRun: RunMetadata,
	signal?: AbortSignal,
	timeoutSec = 1800,
): Promise<RunResult> {
	if (!Number.isInteger(timeoutSec) || timeoutSec <= 0) throw new Error("timeoutSec must be a positive integer")
	let run = initialRun

	// Read the transcript only when returning, never during startup/busy polling.
	const finish = (status?: RunResult["status"], error?: string): RunResult => {
		run = readMetadata(runDirectory(run.handle)) ?? run
		const session = SessionManager.open(run.sessionFile)
		const latest = latestAssistant(session)
		const answer = latest ? assistantText(latest) : ""

		if (status) return resultOf(run, status, answer, session, error)

		// A legacy bridge loaded alongside this one may mark a denied run idle without clearing its error.
		if (run.error) return resultOf(run, "error", answer, session, run.error)

		if (!latest) return resultOf(run, "error", answer, session, `${run.handle} finished without an assistant response`)

		return outcome(run, latest, answer, session)
	}

	const deadline = Date.now() + timeoutSec * 1000

	while (Date.now() < deadline) {
		run = readMetadata(runDirectory(run.handle)) ?? run

		// Waiting observes the child; the caller decides whether cancellation also stops it.
		if (signal?.aborted) return finish("aborted")

		if (run.state === "error") return finish("error", run.error ?? `${run.handle} failed`)
		let alive: boolean

		try {
			alive = (await readProcess(exec, run.blockId, signal)).alive
		} catch (error) {
			if (!signal?.aborted) throw error

			return finish("aborted")
		}

		// The bridge may finish or switch sessions during the asynchronous liveness query.
		run = readMetadata(runDirectory(run.handle)) ?? run

		if (run.state === "error") return finish("error", run.error ?? `${run.handle} failed`)

		if (!alive || run.state === "exited") return finish("error", `${run.handle} exited before finishing`)

		if (run.hasStarted && run.state === "idle" && !inboxPending(run.handle)) return finish()
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
	}

	return finish("error", `timeout after ${timeoutSec}s`)
}

async function spawn(
	exec: Exec,
	pi: ParentHost,
	ctx: ParentContext,
	params: SpawnParameters,
	signal?: AbortSignal,
): Promise<RunMetadata> {
	const provider = params.provider ?? ctx.model?.provider
	const model = params.model ?? ctx.model?.id

	if (!provider) throw new Error("No provider specified and ctx.model is not set")

	if (!model) throw new Error("No model specified and ctx.model is not set")
	const name = params.name === undefined ? undefined : normalizeRunName(params.name)
	const thinking = params.thinkingLevel ?? pi.getThinkingLevel()
	const cwd = resolve(ctx.cwd, params.cwd ?? ".")
	const launchArgs = [...toolFlags(params), ...getChildPolicyArgs(pi.events)]
	const prepared = prepareRun()

	const draft: Omit<RunMetadata, "blockId"> = {
		version: 1,
		handle: prepared.handle,
		parentSessionId: ctx.sessionManager.getSessionId(),
		sessionFile: prepared.sessionFile,
		cwd,
		provider,
		model,
		thinking,
		launchArgs,
		state: "starting",
		hasStarted: false,
		createdAt: new Date().toISOString(),
	}

	if (name !== undefined) draft.name = name

	try {
		const blockId = await newBlock(exec, cwd, prepared.handle, launchCommand(draft, [params.prompt]), signal)
		const run: RunMetadata = { ...draft, blockId }
		writeMetadata(run)

		return run
	} catch (error) {
		removeRunDir(prepared.handle)
		throw error
	}
}

function settledResult(settled: RunResult): AgentToolResult<RunResult> {
	return toolResult(settled, settled.error ?? settled.answer, {
		isError: settled.status !== "success",
		usage: settled.usage,
	})
}

type DisplayStatus = { state: RunState; error?: string }

// Presentation must isolate failed Rex queries without mistaking them for child exits/errors.
async function displayStatus(exec: Exec, run: RunMetadata, signal?: AbortSignal): Promise<DisplayStatus> {
	try {
		signal?.throwIfAborted()
		const state = await effectiveRunState(exec, run, signal)
		const status: DisplayStatus = { state }

		if (run.error) status.error = run.error

		return status
	} catch (error) {
		if (signal?.aborted) throw error

		return { state: "unknown", error: error instanceof Error ? error.message : String(error) }
	}
}

function choose(ui: Pick<ExtensionContext["ui"], "custom">, items: SelectItem[]): Promise<string | undefined> {
	return ui.custom((tui, theme, _keybindings, done) => {
		const list = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		})

		list.onSelect = (item) => done(item.value)
		list.onCancel = () => done(undefined)

		return {
			render: (width) => list.render(width),
			invalidate: () => list.invalidate(),
			handleInput: (data) => {
				list.handleInput(data)
				tui.requestRender()
			},
		}
	})
}

export default function (pi: ExtensionAPI) {
	const childRun = process.env.PI_SUBAGENT_RUN_DIR

	if (childRun) {
		installBridge(pi, childRun)

		return
	}

	installParent(pi)
}

export function installParent(pi: ParentHost): void {
	const exec: Exec = (command, args, signal) => pi.exec(command, args, signal ? { signal } : {})
	let widgetTimer: ReturnType<typeof setInterval> | undefined
	let widgetContext: ParentContext | undefined
	let refreshingWidget = false

	// Ported from pi-subagent; Rex status calls are asynchronous, unlike tmux's.
	const refreshWidget = async (): Promise<void> => {
		if (!widgetContext || refreshingWidget) return
		const ctx = widgetContext
		refreshingWidget = true

		try {
			const activeRuns = (
				await Promise.all(
					listRuns(ctx.sessionManager.getSessionId()).map(async (run) => ({
						run,
						...(await displayStatus(exec, run)),
					})),
				)
			).filter(({ state }) => state !== "exited" && state !== "suspended")

			if (widgetContext !== ctx) return

			if (activeRuns.length === 0) {
				ctx.ui.setWidget("subagents", undefined)

				return
			}

			const visible = activeRuns.slice(0, 5).map(({ run, state }) => {
				const color =
					state === "busy"
						? "warning"
						: state === "idle"
							? "success"
							: state === "error" || state === "unknown"
								? "error"
								: "muted"

				return ctx.ui.theme.fg(color, `${run.name ?? run.handle}:${state}`)
			})

			if (activeRuns.length > visible.length) {
				visible.push(ctx.ui.theme.fg("muted", `+${activeRuns.length - visible.length}`))
			}

			ctx.ui.setWidget(
				"subagents",
				[ctx.ui.theme.fg("dim", "subagents: ") + visible.join(ctx.ui.theme.fg("dim", " | "))],
				{ placement: "belowEditor" },
			)
		} catch {
			if (widgetContext === ctx) {
				ctx.ui.setWidget("subagents", [ctx.ui.theme.fg("error", "subagents: status unavailable")], {
					placement: "belowEditor",
				})
			}
		} finally {
			refreshingWidget = false
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		for (const run of listRuns(ctx.sessionManager.getSessionId())) {
			if (!run.suspended) continue

			try {
				const seen = await readProcess(exec, run.blockId)

				if (seen.alive) {
					updateMetadata(runDirectory(run.handle), { suspended: false })
					continue
				}

				if (seen.exists) await closeBlock(exec, run.blockId)

				if (!existsSync(run.sessionFile)) {
					removeRunDir(run.handle)
					continue
				}

				const starting = updateMetadata(runDirectory(run.handle), { state: "starting" }, ["error"]) ?? run
				const blockId = await newBlock(exec, run.cwd, run.handle, launchCommand(starting))
				updateMetadata(runDirectory(run.handle), { blockId, suspended: false })
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				updateMetadata(runDirectory(run.handle), { state: "error", error: message })

				if (ctx.hasUI) ctx.ui.notify(`Could not resume subagent ${runDisplayName(run)}: ${message}`, "error")
			}
		}

		if (!ctx.hasUI) return
		widgetContext = ctx

		if (widgetTimer) clearInterval(widgetTimer)
		widgetTimer = setInterval(() => void refreshWidget(), 1000)
		widgetTimer.unref()
		await refreshWidget()
	})

	pi.on("session_shutdown", async (event, ctx) => {
		if (widgetTimer) clearInterval(widgetTimer)
		widgetTimer = undefined
		widgetContext = undefined

		if (ctx.hasUI) ctx.ui.setWidget("subagents", undefined)

		if (event.reason === "reload") return
		const failures: Error[] = []

		for (const run of listRuns(ctx.sessionManager.getSessionId())) {
			try {
				const seen = await readProcess(exec, run.blockId)

				if (!seen.alive) {
					if (seen.exists) await closeBlock(exec, run.blockId)

					if (!run.suspended) removeRunDir(run.handle)
					continue
				}

				updateMetadata(runDirectory(run.handle), { suspended: true })
				await closeBlock(exec, run.blockId)
			} catch (error) {
				failures.push(error instanceof Error ? error : new Error(String(error)))
			}
		}

		if (failures.length > 0) throw new AggregateError(failures, "subagent suspend failed")
	})

	registerCommand(pi, exec)
	registerTools(pi, exec)
}

function registerCommand(pi: ParentHost, exec: Exec): void {
	pi.registerCommand("subagent", {
		description: "Select and attach to a subagent spawned by this session",
		handler: async (_args, ctx) => {
			const runs = listRuns(ctx.sessionManager.getSessionId())
			const items: SelectItem[] = []

			for (const run of runs) {
				const status = await displayStatus(exec, run)

				if (status.state === "exited" || status.state === "suspended") continue

				const item: SelectItem = {
					value: run.handle,
					label: `${runDisplayName(run)}  ${status.state.padEnd(8)}  ${run.provider}/${run.model}  ${run.thinking}`,
				}

				if (status.error) item.description = status.error
				items.push(item)
			}

			if (items.length === 0) {
				ctx.ui.notify("No subagents", "info")

				return
			}

			const selected = await choose(ctx.ui, items)

			if (!selected) return
			const run = getRun(selected)
			await showBlock(exec, run.blockId)
		},
	})
}

function registerTools(pi: ParentHost, exec: Exec): void {
	pi.registerTool({
		name: "agent_rename",
		label: "Rename agent",
		description: "Change a subagent's display name without changing its handle.",
		exposure: "codemode",
		parameters: Type.Object({ handle: Type.String({ minLength: 1 }), name: nameParameter }),
		outputSchema: Type.Object({ handle: Type.String(), name: Type.String() }),
		async execute(_id, params) {
			const run = getRun(params.handle)
			const name = normalizeRunName(params.name)
			const updated = updateMetadata(runDirectory(run.handle), { name })

			if (!updated) throw new Error(`Could not rename subagent: ${run.handle}`)

			return toolResult({ handle: run.handle, name }, `Renamed ${runDisplayName(updated)}`)
		},
	})

	pi.registerTool({
		name: "agent_list",
		label: "List agents",
		description:
			"List subagents spawned by this session, including detached and exited children. Failed status queries return unknown with an error; other children are still listed.",
		promptGuidelines: [
			"Use agent_list to rediscover children and their handles, names, and current states if you no longer remember them.",
		],
		exposure: "codemode",
		parameters: Type.Object({}),
		outputSchema: listSchema,
		async execute(_id, _params, signal, _onUpdate, ctx) {
			const runs = await Promise.all(
				listRuns(ctx.sessionManager.getSessionId()).map(async (run) => {
					const item: Static<typeof listSchema>["runs"][number] = {
						handle: run.handle,
						blockId: run.blockId,
						sessionFile: run.sessionFile,
						cwd: run.cwd,
						model: { provider: run.provider, id: run.model },
						thinking: run.thinking,
						...(await displayStatus(exec, run, signal)),
					}

					if (run.name !== undefined) item.name = run.name

					return item
				}),
			)

			const text = runs
				.map(
					(run) =>
						`${runDisplayName(run)}  ${run.state.padEnd(8)}  ${run.model.provider}/${run.model.id}  ${run.thinking}${run.error ? `  ${run.error}` : ""}`,
				)
				.join("\n")

			return toolResult({ runs }, text || "No subagents")
		},
	})

	pi.registerTool({
		name: "agent_spawn",
		label: "Spawn agent",
		description: "Launch a persistent external Pi child in a detached Rex block.",
		promptGuidelines: [
			"Spawning a new child for one-off work is fine. Read its result, then call agent_stop when no follow-up work is needed.",
			"Children persist after completion in either mode. Neither a successful spawn result nor agent_wait stops the child.",
			"With background omitted or false, cancelling agent_spawn closes the child but preserves its transcript. Its 1800-second wait timeout leaves the child running; use agent_wait or agent_stop afterward.",
			"Keep an idle child alive only when concrete follow-up work is expected. It retains its conversation history; use agent_send for that follow-up, then stop it afterward.",
			"Children survive /reload. Parent shutdown suspends them, and resuming the parent relaunches them with their history; this is not permanent cleanup.",
		],
		exposure: "codemode",
		parameters: spawnParameters,
		outputSchema: spawnSchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const run = await spawn(exec, pi, ctx, params, signal)

			if (params.background) {
				const body: BackgroundResult = {
					handle: run.handle,
					blockId: run.blockId,
					sessionFile: run.sessionFile,
					cwd: run.cwd,
					model: { provider: run.provider, id: run.model },
				}

				if (run.name !== undefined) body.name = run.name

				return toolResult(body, `Spawned ${runDisplayName(run)}`)
			}

			try {
				return settledResult(await settle(exec, run, signal))
			} finally {
				if (signal?.aborted) {
					const current = readMetadata(runDirectory(run.handle)) ?? run
					await closeBlock(exec, current.blockId)
				}
			}
		},
	})

	pi.registerTool({
		name: "agent_send",
		label: "Message agent",
		description: "Prompt an idle child, steer active work, or queue a follow-up.",
		promptGuidelines: [
			"Idle children start a new turn with their existing history. Busy children receive steering by default; followUp: true queues another turn after the current work finishes.",
		],
		exposure: "codemode",
		parameters: Type.Object({
			handle: Type.String({ minLength: 1 }),
			message: Type.String({ minLength: 1 }),
			followUp: Type.Optional(Type.Boolean()),
		}),
		outputSchema: handleSchema,
		async execute(_id, params) {
			const run = getRun(params.handle)
			const seen = await readProcess(exec, run.blockId)

			if (!seen.alive) throw new Error(`${run.handle} is not running`)
			enqueue(run.handle, params.message, params.followUp ?? false)

			return toolResult({ handle: run.handle }, `Sent ${runDisplayName(run)}`)
		},
	})

	pi.registerTool({
		name: "agent_wait",
		label: "Wait for agent",
		description: "Wait for a child's current work to finish and return its result. Defaults to a 1800-second timeout.",
		promptGuidelines: [
			"A completed wait does not stop the child. Read its result, then use agent_send for concrete follow-up work or agent_stop when it is no longer needed.",
			"Cancelling or timing out agent_wait stops only the wait, not the child. Use agent_stop to terminate the child explicitly.",
		],
		exposure: "codemode",
		parameters: Type.Object({
			handle: Type.String({ minLength: 1 }),
			timeoutSec: Type.Optional(Type.Integer({ minimum: 1, default: 1800 })),
		}),
		outputSchema: runResultSchema,
		async execute(_id, params, signal) {
			return settledResult(await settle(exec, getRun(params.handle), signal, params.timeoutSec))
		},
	})

	pi.registerTool({
		name: "agent_stop",
		label: "Stop agent",
		description: "Terminate a child by closing its Rex block and deleting its run transcript and metadata.",
		promptGuidelines: [
			"Stopping permanently deletes the child's transcript and metadata. Read its result and preserve anything needed before stopping it.",
			"Explicitly stop every child when it is no longer needed; do not leave completed children running idle.",
		],
		exposure: "codemode",
		parameters: Type.Object({ handle: Type.String({ minLength: 1 }) }),
		outputSchema: handleSchema,
		async execute(_id, params) {
			const run = getRun(params.handle)
			const seen = await readProcess(exec, run.blockId)

			if (seen.exists) await closeBlock(exec, run.blockId)
			removeRunDir(run.handle)

			return toolResult({ handle: run.handle }, `Stopped ${runDisplayName(run)}`)
		},
	})
}

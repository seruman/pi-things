import { afterEach, expect } from "bun:test"
import { randomUUID } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripVTControlCharacters } from "node:util"
import {
	type AssistantMessage,
	InMemoryCredentialStore,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type TranscriptContext,
	Type,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai"
import {
	type AgentSession,
	type CreateAgentSessionOptions,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
	initTheme,
} from "@earendil-works/pi-coding-agent"
import { TuiMainScreen, type Terminal, setKeybindings } from "@earendil-works/pi-tui"
// Pi exports this class only as a type; use its installed implementation, which includes TUI_KEYBINDINGS.
import { KeybindingsManager } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js"
import type { Classification, ClassifyTier, RoutingInput } from "../classifier"
import type { RouterConfig, Tier } from "../config"
import { createModelRouterExtension } from "../index"

export const ROUTER_NAME = "test"

export const ROUTER_MODEL = "auto-test"

export type TestTiers = Record<Tier, Omit<RouterConfig["tiers"][Tier], "provider"> & { provider?: string }>

// The real TUI owns input dispatch and focus. Only terminal IO is in memory.
class MemoryTerminal implements Terminal {
	columns = 120
	rows = 40
	kittyProtocolActive = false
	output: string[] = []
	title = ""
	progress = false
	programStatus: Parameters<Terminal["setProgramStatus"]>[0] | undefined
	private onInput?: (data: string) => void

	start(onInput: (data: string) => void) {
		this.onInput = onInput
	}
	stop() {
		this.onInput = undefined
	}
	async drainInput() {}
	write(data: string) {
		this.output.push(data)
	}
	press(data: string) {
		if (!this.onInput) throw new Error("Terminal is not running")
		this.onInput(data)
	}
	moveBy(lines: number) {
		if (lines) this.write(`\x1b[${Math.abs(lines)}${lines < 0 ? "A" : "B"}`)
	}
	hideCursor() {
		this.write("\x1b[?25l")
	}
	showCursor() {
		this.write("\x1b[?25h")
	}
	clearLine() {
		this.write("\x1b[2K")
	}
	clearFromCursor() {
		this.write("\x1b[J")
	}
	clearScreen() {
		this.write("\x1b[2J\x1b[H")
	}
	setTitle(title: string) {
		this.title = title
	}
	setProgress(active: boolean) {
		this.progress = active
	}
	setProgramStatus(status: Parameters<Terminal["setProgramStatus"]>[0]) {
		this.programStatus = status
	}
}

export interface RouterPanel {
	press(data: string): void
	frame(): string
	readonly closed: boolean
}

export interface RouterSettings {
	preset?: string
	enabled?: boolean
}

interface RouterPanelHost {
	ready: ReturnType<typeof gate>
	panel?: RouterPanel
}

// Only the classifier, physical transport, and host UI are fakes. Routing,
// extension events, tools, queues, context, and persistence use the installed SDK.
export const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

export function gate() {
	let open!: () => void

	const promise = new Promise<void>((resolve) => {
		open = resolve
	})

	return { promise, open }
}

export async function waitForGate(promise: Promise<void>, signal?: AbortSignal) {
	signal?.throwIfAborted()
	let abort!: () => void

	const aborted = new Promise<never>((_, reject) => {
		abort = () => reject(signal?.reason ?? new Error("aborted"))
		signal?.addEventListener("abort", abort, { once: true })
	})

	try {
		await Promise.race([promise, aborted])
	} finally {
		signal?.removeEventListener("abort", abort)
	}
}

export function classified(tier: Tier, newTask = true, confidence = 0.95, strongProbability?: number): Classification {
	return {
		kind: "classified",
		tier,
		newTask,
		durationMs: 1,
		probabilities:
			strongProbability === undefined
				? { standard: 0.01, strong: 0.01, [tier]: 0.99 }
				: { standard: 1 - strongProbability, strong: strongProbability },
		confidence,
		newTaskProbability: newTask ? 0.9 : 0.1,
	}
}

export function classifierSequence(...answers: Classification[]) {
	const inputs: RoutingInput[] = []

	const classify: ClassifyTier = async (_config, input, _registry, signal) => {
		signal?.throwIfAborted()
		inputs.push(structuredClone(input))
		const answer = answers.shift()

		if (!answer) throw new Error("Unexpected classification")

		return answer
	}

	return { classify, inputs }
}

export type Step = { tool?: boolean; wait?: Promise<void>; started?: () => void; error?: string; text?: string }

export type Dispatch = {
	model: string
	provider: string
	thinking: SimpleStreamOptions["reasoning"]
	context: TranscriptContext
	options: Pick<SimpleStreamOptions, "maxTokens" | "cacheRetention" | "sessionId">
}

type Settings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>

export interface HarnessOptions {
	classify?: ClassifyTier
	classifier?: RouterConfig["classifier"]
	strongProbabilityThreshold?: number
	minConfidence?: number
	steps?: Step[]
	extraExtension?: ExtensionFactory
	retry?: boolean
	toolFailures?: boolean[]
	tiers?: TestTiers
	configFile?: boolean
	loadFromDisk?: boolean
	// Most routing tests explicitly enable the test preset through the real command.
	enableRouter?: boolean
	settings?: Partial<Settings>
	modelOverrides?: Partial<Model<"test-physical-api">>
	usage?: AssistantMessage["usage"]
	routers?: (providers: { primary: string; alternate: string }) => Record<string, { tiers: RouterConfig["tiers"] }>
}

export async function harness(options: HarnessOptions = {}) {
	// Initialize the SDK's real TUI theme, without a filesystem watcher.
	initTheme("dark", false)
	const root = mkdtempSync(join(tmpdir(), "model-router-sdk-"))
	cleanups.push(() => rmSync(root, { recursive: true, force: true }))
	const cwd = join(root, "workspace")
	const agentDir = join(root, "agent")
	mkdirSync(cwd)
	mkdirSync(agentDir)
	const providerId = `test-physical-${randomUUID()}`
	const alternateProviderId = `test-alternate-${randomUUID()}`
	const configPath = join(root, "model-router.json")

	const tiers: TestTiers = options.tiers ?? {
		standard: { model: "middle", thinking: "medium" },
		strong: { model: "big", thinking: "high" },
	}

	if (options.configFile !== false) {
		writeFileSync(
			configPath,
			JSON.stringify({
				routers: {
					[ROUTER_NAME]: {
						tiers: Object.fromEntries(
							Object.entries(tiers).map(([tier, target]) => [tier, { provider: providerId, ...target }]),
						),
					},
					...options.routers?.({ primary: providerId, alternate: alternateProviderId }),
				},
				classifier: options.classifier,
				strongProbabilityThreshold: options.strongProbabilityThreshold,
				minConfidence: options.minConfidence,
			}),
		)
	}

	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	})

	const models: Model<"test-physical-api">[] = ["small", "middle", "big"].map((id) => ({
		id,
		provider: providerId,
		name: id,
		api: "test-physical-api",
		baseUrl: "http://unused.invalid",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...options.modelOverrides,
	}))

	const dispatches: Dispatch[] = []
	const steps = [...(options.steps ?? [])]
	const transportErrors: unknown[] = []

	const stream: Provider["streamSimple"] = (model, context, streamOptions) => {
		const output = createAssistantMessageEventStream()
		const index = dispatches.length
		dispatches.push({
			model: model.id,
			provider: model.provider,
			thinking: streamOptions?.reasoning,
			context: structuredClone(context),
			options: {
				maxTokens: streamOptions?.maxTokens,
				cacheRetention: streamOptions?.cacheRetention,
				sessionId: streamOptions?.sessionId,
			},
		})

		const message: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [],
			stopReason: "pending",
			timestamp: Date.now(),
			usage: structuredClone(
				options.usage ?? {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			),
		}

		void (async () => {
			try {
				const step = steps.shift()

				if (!step) throw new Error(`Unexpected physical request ${index + 1}`)
				step.started?.()

				if (step.wait) await waitForGate(step.wait, streamOptions?.signal)
				streamOptions?.signal?.throwIfAborted()

				if (step.error) {
					message.stopReason = "error"
					message.errorMessage = step.error
					output.push({ type: "error", reason: "error", error: message })

					return
				}

				output.push({ type: "start", partial: message })

				if (step.tool) {
					const toolCall = { type: "toolCall" as const, id: `call-${index}`, name: "probe", arguments: {} }
					message.content.push(toolCall)
					output.push({ type: "toolcall_start", contentIndex: 0, partial: message })
					output.push({ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: message })
					output.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message })
					message.stopReason = "toolUse"
				} else {
					message.content.push({ type: "text", text: "" })
					output.push({ type: "text_start", contentIndex: 0, partial: message })
					const text = step.text ?? "done"
					message.content[0] = { type: "text", text }
					output.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message })
					output.push({ type: "text_end", contentIndex: 0, content: text, partial: message })
					message.stopReason = "stop"
				}

				output.push({ type: "done", reason: message.stopReason, message })
			} catch (error) {
				transportErrors.push(error)
				message.stopReason = streamOptions?.signal?.aborted ? "aborted" : "error"
				message.errorMessage = String(error)
				output.push({ type: "error", reason: message.stopReason, error: message })
			} finally {
				output.end()
			}
		})()

		return output
	}

	for (const id of [providerId, alternateProviderId]) {
		runtime.registerNativeProvider({
			id,
			name: "In-process test transport",
			getModels: () => models.map((model) => ({ ...model, provider: id })),
			auth: { apiKey: { name: "Keyless test provider", resolve: async () => ({ auth: {} }) } },
			stream: (model, context) => stream(model, context),
			streamSimple: stream,
		})
	}

	await runtime.refresh({ allowNetwork: false })

	for (const id of [providerId, alternateProviderId]) expect(runtime.hasConfiguredAuth(id)).toBe(true)
	let extensionPath: string | undefined

	if (options.loadFromDisk) {
		const extensionDir = join(root, "extension")
		mkdirSync(join(extensionDir, "node_modules"), { recursive: true })
		symlinkSync(dirname(fileURLToPath(import.meta.resolve("zod/package.json"))), join(extensionDir, "node_modules/zod"))

		for (const file of [
			"index.ts",
			"router.ts",
			"classifier.ts",
			"config.ts",
			"progress.ts",
			"context.ts",
			"state.ts",
			"summaries.ts",
			"settings.ts",
		]) {
			copyFileSync(join(import.meta.dir, "..", file), join(extensionDir, file))
		}

		extensionPath = join(extensionDir, "test-entry.ts")
		writeFileSync(
			extensionPath,
			`import { createModelRouterExtension } from "./index.ts"\nexport default createModelRouterExtension({ configPath: ${JSON.stringify(configPath)} })\n`,
		)
	}

	const boundaries: string[] = []
	const extensionErrors: unknown[] = []
	const widgets: (string[] | undefined)[] = []
	const notifications: string[] = []
	const settingsFrames: string[] = []
	const statuses = new Map<string, string>()
	const panels = new Map<AgentSession, RouterPanelHost>()
	let toolExecutions = 0
	const sessions: AgentSession[] = []
	cleanups.push(async () => {
		for (const session of sessions) {
			await session.abort()
			session.dispose()
		}
	})

	async function openRouter(target: AgentSession) {
		if (panels.has(target)) throw new Error("Router settings are already open")
		const host: RouterPanelHost = { ready: gate() }
		panels.set(target, host)
		const result = target.prompt("/router")
		await Promise.race([
			host.ready.promise,
			result.then(() => {
				throw new Error("/router finished without opening custom settings UI")
			}),
		])
		const panel = host.panel

		if (!panel) throw new Error("Router panel was not mounted")

		return {
			...panel,
			get closed() {
				return panel.closed
			},
			result,
		}
	}

	async function configureRouter(settings: RouterSettings, target: AgentSession) {
		// Separate interactions let each immediate async change settle before the next key.
		if (settings.preset !== undefined) {
			const panel = await openRouter(target)
			panel.press("\x1b[B")
			panel.press("\r")
			const seen = new Set<string>()

			while (true) {
				const selected = panel
					.frame()
					.split("\n")
					.find((line) => line.trimStart().startsWith("→ "))
					?.trim()

				if (!selected || seen.has(selected)) throw new Error(`Preset ${settings.preset} not found in settings`)

				if (selected.slice(2).trim().split(/\s+/)[0] === settings.preset) break
				seen.add(selected)
				panel.press("\x1b[B")
			}

			panel.press("\r")
			panel.press("\x1b")
			await panel.result
		}

		if (settings.enabled !== undefined) {
			const panel = await openRouter(target)
			const enabled = panel.frame().match(/Enabled\s+(yes|no)\b/)

			if (!enabled) throw new Error("Missing Enabled setting")

			if ((enabled[1] === "yes") !== settings.enabled) panel.press("\r")
			panel.press("\x1b")
			await panel.result
		}
	}

	async function choosePreset(name: string | undefined, target: AgentSession) {
		if (name !== undefined) return configureRouter({ preset: name, enabled: true }, target)
		const panel = await openRouter(target)
		panel.press("\x1b[B")
		panel.press("\r")
		panel.press("\x1b")
		panel.press("\x1b")
		await panel.result
	}

	async function open(
		manager = SessionManager.create(cwd, join(root, "sessions")),
		resume = false,
		selection: Pick<CreateAgentSessionOptions, "model" | "thinkingLevel"> = {},
	) {
		const settingsManager = SettingsManager.inMemory({
			defaultTools: [],
			compaction: { enabled: false },
			cacheWarming: "off",
			retry: { enabled: options.retry ?? false, maxRetries: 1, baseDelayMs: 1 },
			...options.settings,
		})

		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "You are an isolated SDK test agent.",
			additionalExtensionPaths: extensionPath ? [extensionPath] : [],
			extensionFactories: [
				...(extensionPath ? [] : [createModelRouterExtension({ configPath, classify: options.classify })]),
				(pi) => {
					pi.on("before_agent_start", (event) => {
						boundaries.push(event.prompt)
					})
					pi.registerTool({
						name: "probe",
						label: "Probe",
						description: "In-memory probe",
						parameters: Type.Object({}),
						execute: async () => {
							toolExecutions++
							const isError = options.toolFailures?.[toolExecutions - 1] ?? false

							return {
								content: [{ type: "text", text: isError ? "probe failed" : "probe succeeded" }],
								details: {},
								isError,
							}
						},
					})
				},
				...(options.extraExtension ? [options.extraExtension] : []),
			],
		})

		await loader.reload()
		expect(loader.getExtensions().errors).toEqual([])

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: runtime,
			resourceLoader: loader,
			settingsManager,
			sessionManager: manager,
			model: resume ? undefined : models[0],
			...selection,
			noTools: "builtin",
		})

		sessions.push(session)
		expect(modelFallbackMessage).toBeUndefined()
		const runner = session.extensionRunner
		await session.bindExtensions({
			mode: "tui",
			uiContext: {
				...runner.getUIContext(),
				custom: async (factory) => {
					const host = panels.get(session)

					if (!host) throw new Error("Unexpected custom UI")
					const terminal = new MemoryTerminal()
					const tui = new TuiMainScreen(terminal)
					const keybindings = new KeybindingsManager()
					setKeybindings(keybindings)
					const finished = gate()
					let closed = false
					let result!: Parameters<Parameters<typeof factory>[3]>[0]

					const component = await factory(tui, runner.getUIContext().theme, keybindings, (value) => {
						result = value
						closed = true
						finished.open()
					})

					const frame = () => {
						const text = stripVTControlCharacters(component.render(terminal.columns).join("\n"))
						settingsFrames.push(text)

						return text
					}

					tui.addChild(component)
					tui.setFocus(component)
					tui.start()
					host.panel = {
						press(data) {
							if (closed) throw new Error("Router panel is closed")
							terminal.press(data)
							frame()
						},
						frame,
						get closed() {
							return closed
						},
					}
					frame()
					host.ready.open()
					cleanups.push(() => tui.stop())

					try {
						await finished.promise

						return result
					} finally {
						tui.stop()
						component.dispose?.()
						panels.delete(session)
					}
				},
				select: async () => {
					throw new Error("Router must use the native settings panel, not a standalone picker")
				},
				setStatus(key, text) {
					if (text === undefined) statuses.delete(key)
					else statuses.set(key, text)
				},
				setWidget(_key, content) {
					if (content !== undefined && !Array.isArray(content)) throw new Error("Expected a text routing widget")
					widgets.push(content)
				},
				notify: (message) => notifications.push(message),
			},
			onError: (error) => {
				extensionErrors.push(error)
			},
		})

		if (!resume && options.configFile !== false && options.enableRouter !== false) {
			await choosePreset(ROUTER_NAME, session)
		}

		return session
	}

	const session = await open()

	return {
		session,
		runtime,
		providerId,
		alternateProviderId,
		dispatches,
		boundaries,
		widgets,
		notifications,
		settingsFrames,
		statuses,
		open,
		openRouter: (target = session) => openRouter(target),
		configureRouter: (settings: RouterSettings, target = session) => configureRouter(settings, target),
		disableRouter: (target = session) => configureRouter({ enabled: false }, target),
		choosePreset: (name: string | undefined, target = session) => choosePreset(name, target),
		get toolExecutions() {
			return toolExecutions
		},
		assertHealthy() {
			expect(extensionErrors).toEqual([])
			expect(transportErrors).toEqual([])
			expect(steps).toHaveLength(0)
		},
	}
}

export function requiredModel(runtime: ModelRuntime, provider: string, id: string) {
	const model = runtime.getModel(provider, id)

	if (!model) throw new Error(`Missing test model ${provider}/${id}`)

	return model
}

export function customEntries(session: AgentSession, customType: string) {
	return session.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom")
		.filter((entry) => entry.customType === customType)
}

export function routes(dispatches: Dispatch[]) {
	return dispatches.map(({ model, thinking }) => [model, thinking])
}

import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
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
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	VIRTUAL_MODEL_STATE_ENTRY,
	createAgentSession,
} from "@earendil-works/pi-coding-agent"
import type { Classification, ClassifyTier, RoutingInput } from "./classifier"
import type { RouterConfig, Tier } from "./config"
import { createModelRouterExtension } from "./index"
import { DECISION_ENTRY, ROUTER_PROVIDER } from "./router"

const ROUTER_MODEL = "test"
type TestTiers = Record<Tier, Omit<RouterConfig["tiers"][Tier], "provider"> & { provider?: string }>

// Only the classifier and physical transport are fakes. Routing, extension events,
// tools, queues, context reconstruction, and persistence use the installed SDK.
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function gate() {
	let open!: () => void
	const promise = new Promise<void>((resolve) => {
		open = resolve
	})
	return { promise, open }
}

async function waitForGate(promise: Promise<void>, signal?: AbortSignal) {
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

function classified(tier: Tier, newTask = true, confidence = 0.95): Classification {
	return {
		kind: "classified",
		tier,
		newTask,
		durationMs: 1,
		probabilities: { trivial: 0.005, standard: 0.005, strong: 0.005, [tier]: 0.99 },
		confidence,
		newTaskProbability: newTask ? 0.9 : 0.1,
	}
}

function classifierSequence(...answers: Classification[]) {
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

type Step = { tool?: boolean; wait?: Promise<void>; started?: () => void; error?: string }
type Dispatch = {
	model: string
	provider: string
	thinking: SimpleStreamOptions["reasoning"]
	context: TranscriptContext
}

async function harness(
	options: {
		classify?: ClassifyTier
		classifier?: RouterConfig["classifier"]
		minConfidence?: number
		steps?: Step[]
		extraExtension?: ExtensionFactory
		retry?: boolean
		toolFailures?: boolean[]
		tiers?: TestTiers
		configFile?: boolean
		loadFromDisk?: boolean
		routers?: (providers: { primary: string; alternate: string }) => Record<string, { tiers: RouterConfig["tiers"] }>
	} = {},
) {
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
		trivial: { model: "small", thinking: "low" },
		standard: { model: "middle", thinking: "medium" },
		strong: { model: "big", thinking: "high" },
	}
	if (options.configFile !== false) {
		writeFileSync(
			configPath,
			JSON.stringify({
				routers: {
					[ROUTER_MODEL]: {
						tiers: Object.fromEntries(
							Object.entries(tiers).map(([tier, target]) => [tier, { provider: providerId, ...target }]),
						),
					},
					...options.routers?.({ primary: providerId, alternate: alternateProviderId }),
				},
				classifier: options.classifier,
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
		})
		const message: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [],
			stopReason: "pending",
			timestamp: Date.now(),
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
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
					message.content[0] = { type: "text", text: "done" }
					output.push({ type: "text_delta", contentIndex: 0, delta: "done", partial: message })
					output.push({ type: "text_end", contentIndex: 0, content: "done", partial: message })
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
		for (const file of ["index.ts", "router.ts", "classifier.ts", "config.ts"]) {
			copyFileSync(join(import.meta.dir, file), join(extensionDir, file))
		}
		extensionPath = join(extensionDir, "test-entry.ts")
		writeFileSync(
			extensionPath,
			`import { createModelRouterExtension } from "./index.ts"\nexport default createModelRouterExtension({ configPath: ${JSON.stringify(configPath)} })\n`,
		)
	}

	const boundaries: string[] = []
	const extensionErrors: unknown[] = []
	let toolExecutions = 0
	const sessions: AgentSession[] = []
	cleanups.push(async () => {
		for (const session of sessions) {
			await session.abort()
			session.dispose()
		}
	})
	async function open(manager = SessionManager.create(cwd, join(root, "sessions")), resume = false) {
		const settingsManager = SettingsManager.inMemory({
			defaultTools: [],
			compaction: { enabled: false },
			cacheWarming: "off",
			retry: { enabled: options.retry ?? false, maxRetries: 1, baseDelayMs: 1 },
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
			noTools: "builtin",
		})
		sessions.push(session)
		expect(modelFallbackMessage).toBeUndefined()
		await session.bindExtensions({
			onError: (error) => {
				extensionErrors.push(error)
			},
		})
		if (!resume && options.configFile !== false) {
			await session.setModel(requiredModel(runtime, ROUTER_PROVIDER, ROUTER_MODEL))
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
		open,
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

function requiredModel(runtime: ModelRuntime, provider: string, id: string) {
	const model = runtime.getModel(provider, id)
	if (!model) throw new Error(`Missing test model ${provider}/${id}`)
	return model
}

function customEntries(session: AgentSession, customType: string) {
	return session.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom")
		.filter((entry) => entry.customType === customType)
}

function routes(dispatches: Dispatch[]) {
	return dispatches.map(({ model, thinking }) => [model, thinking])
}

describe("model-router SDK integration", () => {
	test("registers codex and bedrock without a configuration file or physical requests", async () => {
		const classifier = classifierSequence()
		const h = await harness({ configFile: false, classify: classifier.classify })
		expect(
			h.runtime
				.getAllModels(ROUTER_PROVIDER)
				.map((model) => model.id)
				.sort(),
		).toEqual(["bedrock", "codex"])
		expect((await h.runtime.getAvailable(ROUTER_PROVIDER)).map((model) => model.id).sort()).toEqual([
			"bedrock",
			"codex",
		])
		for (const id of ["codex", "bedrock"]) {
			await h.session.setModel(requiredModel(h.runtime, ROUTER_PROVIDER, id))
			expect(h.session.model?.id).toBe(id)
			expect(h.session.model?.provider).toBe(ROUTER_PROVIDER)
			expect(h.session.thinkingLevel).toBe("off")
		}
		expect(classifier.inputs).toEqual([])
		expect(h.dispatches).toEqual([])
		expect(customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY)).toEqual([])
		expect(customEntries(h.session, DECISION_ENTRY)).toEqual([])
		h.assertHealthy()
	})

	test("routes custom tiers across providers and isolates state when switching named routers", async () => {
		const otherRouter = "other"
		const classifier = classifierSequence(
			classified("trivial"),
			classified("strong"),
			classified("standard", false),
			classified("trivial", false),
			classified("strong", false),
		)
		const h = await harness({
			classify: classifier.classify,
			steps: [{}, {}, {}, {}, {}],
			routers: ({ primary, alternate }) => ({
				[ROUTER_MODEL]: {
					tiers: {
						trivial: { provider: primary, model: "small", thinking: "low" },
						standard: { provider: alternate, model: "middle", thinking: "medium" },
						strong: { provider: primary, model: "big", thinking: "high" },
					},
				},
				[otherRouter]: {
					tiers: {
						trivial: { provider: alternate, model: "small", thinking: "medium" },
						standard: { provider: primary, model: "middle", thinking: "low" },
						strong: { provider: alternate, model: "big", thinking: "low" },
					},
				},
			}),
		})
		expect(
			h.runtime
				.getAllModels(ROUTER_PROVIDER)
				.map((model) => model.id)
				.sort(),
		).toEqual(["bedrock", "codex", otherRouter, ROUTER_MODEL])
		await h.session.prompt("Test router task")
		for (const [name, prompt] of [
			[otherRouter, "Other router task"],
			[ROUTER_MODEL, "Continue test at standard"],
			[otherRouter, "Continue other at trivial"],
			[ROUTER_MODEL, "Continue test at strong"],
		]) {
			const beforeSwitch = structuredClone(customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY))
			await h.session.setModel(requiredModel(h.runtime, ROUTER_PROVIDER, name))
			expect(customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY)).toEqual(beforeSwitch)
			await h.session.prompt(prompt)
			expect(h.session.model?.provider).toBe(ROUTER_PROVIDER)
			expect(h.session.model?.id).toBe(name)
			expect(h.session.thinkingLevel).toBe("off")
		}
		expect(classifier.inputs).toEqual([
			{ prompt: "Test router task", hasImages: false },
			{ prompt: "Other router task", hasImages: false },
			{ prompt: "Continue test at standard", hasImages: false, currentTier: "trivial", task: "Test router task" },
			{ prompt: "Continue other at trivial", hasImages: false, currentTier: "strong", task: "Other router task" },
			{ prompt: "Continue test at strong", hasImages: false, currentTier: "standard", task: "Test router task" },
		])
		expect(h.dispatches.map(({ provider, model, thinking }) => [provider, model, thinking])).toEqual([
			[h.providerId, "small", "low"],
			[h.alternateProviderId, "big", "low"],
			[h.alternateProviderId, "middle", "medium"],
			[h.alternateProviderId, "small", "medium"],
			[h.providerId, "big", "high"],
		])
		const states = customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY)
		expect(states).toHaveLength(5)
		for (const [index, modelId, tier, task] of [
			[0, ROUTER_MODEL, "trivial", "Test router task"],
			[1, otherRouter, "strong", "Other router task"],
			[2, ROUTER_MODEL, "standard", "Test router task"],
			[3, otherRouter, "trivial", "Other router task"],
			[4, ROUTER_MODEL, "strong", "Test router task"],
		] as const) {
			const { provider, model, thinking } = h.dispatches[index]
			expect(states[index].data).toMatchObject({
				provider: ROUTER_PROVIDER,
				modelId,
				state: { tier, task, failures: 0, selection: { provider, model, thinking } },
			})
		}
		expect(customEntries(h.session, DECISION_ENTRY).map((entry) => (entry.data as { router: string }).router)).toEqual([
			ROUTER_MODEL,
			otherRouter,
			ROUTER_MODEL,
			otherRouter,
			ROUTER_MODEL,
		])
		h.assertHealthy()
	})

	test("classifies only fresh idle prompts, not tool continuations or queued steering/follow-ups", async () => {
		const classifier = classifierSequence(classified("trivial"), classified("standard", false))
		const started = gate()
		const release = gate()
		const h = await harness({
			classify: classifier.classify,
			steps: [{ tool: true }, { tool: true, started: started.open, wait: release.promise }, {}, {}, {}],
		})
		const run = h.session.prompt("Implement the original task")
		try {
			await Promise.race([
				started.promise,
				run.then(() => {
					throw new Error(`Run ended before the queue boundary: ${JSON.stringify(h.session.messages)}`)
				}),
			])
			expect(classifier.inputs).toEqual([{ prompt: "Implement the original task", hasImages: false }])
			expect(h.toolExecutions).toBe(1)
			expect(await h.session.steer("Use the existing helper")).toBe("queued")
			expect(await h.session.followUp("Also check the result")).toBe("queued")
		} finally {
			release.open()
			await run
		}
		await h.session.waitForIdle()
		expect(h.toolExecutions).toBe(2)
		expect(classifier.inputs).toHaveLength(1)
		expect(h.boundaries).toEqual(["Implement the original task"])
		expect(routes(h.dispatches)).toEqual([
			["small", "low"],
			["small", "low"],
			["small", "low"],
			["small", "low"],
		])
		expect(h.session.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
			[{ type: "text", text: "Implement the original task" }],
			[{ type: "text", text: "Use the existing helper" }],
			[{ type: "text", text: "Also check the result" }],
		])
		await h.session.prompt("Now review that implementation")
		expect(classifier.inputs).toEqual([
			{ prompt: "Implement the original task", hasImages: false },
			{
				prompt: "Now review that implementation",
				hasImages: false,
				currentTier: "trivial",
				task: "Implement the original task",
			},
		])
		expect(h.boundaries).toEqual(["Implement the original task", "Now review that implementation"])
		expect(routes(h.dispatches).at(-1)).toEqual(["middle", "medium"])
		expect(h.dispatches.every((dispatch) => dispatch.provider === h.providerId)).toBe(true)
		expect(h.session.model?.provider).toBe(ROUTER_PROVIDER)
		expect(h.session.model?.id).toBe(ROUTER_MODEL)
		expect(h.session.thinkingLevel).toBe("off")
		h.assertHealthy()
	})

	test("persists native routing state, excludes diagnostics from context, and restores the active branch on resume", async () => {
		const classifier = classifierSequence(
			classified("trivial"),
			classified("strong"),
			classified("standard", false),
			classified("trivial", false),
			classified("strong", false),
		)
		const h = await harness({ classify: classifier.classify, steps: [{}, {}, {}, {}, {}] })
		await h.session.prompt("Task A: update a label")
		const leafA = h.session.sessionManager.getLeafId()
		if (!leafA) throw new Error("Missing task A leaf")
		const stateA = structuredClone(customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY))
		expect(stateA).toHaveLength(1)
		expect(stateA[0].data).toMatchObject({
			provider: ROUTER_PROVIDER,
			modelId: ROUTER_MODEL,
			state: { version: 1, tier: "trivial", task: "Task A: update a label", failures: 0 },
		})
		const userA = h.session.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "user")
		if (!userA) throw new Error("Missing task A user entry")
		expect(stateA[0].data).toMatchObject({ state: { toolCursor: userA.id } })
		expect(customEntries(h.session, DECISION_ENTRY)).toHaveLength(1)
		expect(customEntries(h.session, DECISION_ENTRY)[0].data).toMatchObject({
			action: "classified",
			reason: "user",
			model: "small",
			thinking: "low",
			userEntryId: userA.id,
			classifier: { kind: "classified", probabilities: { trivial: 0.99 } },
		})

		await h.session.prompt("Task B: redesign the architecture")
		const leafB = h.session.sessionManager.getLeafId()
		if (!leafB) throw new Error("Missing task B leaf")
		const stateB = structuredClone(customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY))
		expect(stateB.at(-1)?.data).toMatchObject({ state: { tier: "strong", task: "Task B: redesign the architecture" } })
		expect((await h.session.navigateTree(leafA, { summarize: false })).cancelled).toBe(false)
		expect(customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY)).toEqual(stateA)
		await h.session.prompt("Continue A")
		expect(classifier.inputs[2]).toEqual({
			prompt: "Continue A",
			hasImages: false,
			currentTier: "trivial",
			task: "Task A: update a label",
		})

		const file = h.session.sessionFile
		if (!file) throw new Error("Missing persisted session file")
		const branchBeforeResume = structuredClone(h.session.sessionManager.getBranch())
		h.session.dispose()
		// Reuse the catalog runtime, but load a fresh extension factory and reopen
		// actual JSONL. No router closure or in-memory SessionManager is reused.
		const resumed = await h.open(SessionManager.open(file), true)
		expect(resumed.sessionManager.getBranch()).toEqual(branchBeforeResume)
		expect(resumed.model?.provider).toBe(ROUTER_PROVIDER)
		expect(resumed.model?.id).toBe(ROUTER_MODEL)
		expect(resumed.thinkingLevel).toBe("off")
		expect(customEntries(resumed, VIRTUAL_MODEL_STATE_ENTRY).at(-1)?.data).toMatchObject({
			state: { tier: "standard", task: "Task A: update a label" },
		})
		await resumed.prompt("Continue after resume")
		expect(classifier.inputs[3]).toEqual({
			prompt: "Continue after resume",
			hasImages: false,
			currentTier: "standard",
			task: "Task A: update a label",
		})
		expect((await resumed.navigateTree(leafB, { summarize: false })).cancelled).toBe(false)
		expect(customEntries(resumed, VIRTUAL_MODEL_STATE_ENTRY)).toEqual(stateB)
		await resumed.prompt("Continue B")
		expect(classifier.inputs[4]).toEqual({
			prompt: "Continue B",
			hasImages: false,
			currentTier: "strong",
			task: "Task B: redesign the architecture",
		})
		expect(routes(h.dispatches)).toEqual([
			["small", "low"],
			["big", "high"],
			["middle", "medium"],
			["small", "low"],
			["big", "high"],
		])
		const lastContext = JSON.stringify(h.dispatches.at(-1)?.context)
		expect(lastContext).toContain("Task B: redesign the architecture")
		expect(lastContext).not.toContain("Continue after resume")
		expect(lastContext).not.toContain("Continue A")
		for (const messages of [
			...h.dispatches.map((dispatch) => dispatch.context.messages),
			resumed.messages,
			resumed.sessionManager.buildSessionContext().messages,
		]) {
			const context = JSON.stringify(messages)
			for (const privateData of [
				DECISION_ENTRY,
				VIRTUAL_MODEL_STATE_ENTRY,
				"probabilities",
				"toolCursor",
				"newTaskProbability",
			]) {
				expect(context).not.toContain(privateData)
			}
		}
		h.assertHealthy()
	})

	test("a configured confidence gate dispatches strong, stays sticky through retries/tools, and persists across resume", async () => {
		const decision = classified("standard", true, 0.89)
		const classifier = classifierSequence(decision, classified("trivial", false, 0.9))
		const h = await harness({
			classify: classifier.classify,
			minConfidence: 0.9,
			retry: true,
			steps: [{ error: "429 rate limit exceeded" }, { tool: true }, {}, {}],
		})
		await h.session.prompt("Original task")
		await h.session.waitForIdle()
		expect(routes(h.dispatches)).toEqual([
			["big", "high"],
			["big", "high"],
			["big", "high"],
		])
		expect(classifier.inputs).toHaveLength(1)
		expect(h.toolExecutions).toBe(1)
		const decisions = structuredClone(customEntries(h.session, DECISION_ENTRY))
		expect(decisions[0].data).toMatchObject({
			action: "confidence-gated",
			tier: "strong",
			minConfidence: 0.9,
			classifier: decision,
		})
		expect(decisions[1].data).toMatchObject({ reason: "retry", action: "retained", tier: "strong" })
		const file = h.session.sessionFile
		if (!file) throw new Error("Missing persisted session file")
		h.session.dispose()
		const resumed = await h.open(SessionManager.open(file), true)
		expect(customEntries(resumed, DECISION_ENTRY)).toEqual(decisions)
		expect(customEntries(resumed, VIRTUAL_MODEL_STATE_ENTRY).at(-1)?.data).toMatchObject({
			state: {
				tier: "strong",
				task: "Original task",
				selection: { provider: h.providerId, model: "big", thinking: "high" },
			},
		})
		await resumed.prompt("Continue after resume")
		expect(classifier.inputs[1]).toMatchObject({ currentTier: "strong", task: "Original task" })
		expect(routes(h.dispatches).at(-1)).toEqual(["small", "low"])
		expect(customEntries(resumed, DECISION_ENTRY).at(-1)?.data).toMatchObject({
			action: "classified",
			tier: "trivial",
			minConfidence: 0.9,
			classifier: { confidence: 0.9 },
		})
		for (const dispatch of h.dispatches) {
			const context = JSON.stringify(dispatch.context)
			for (const privateData of [DECISION_ENTRY, "confidence-gated", "minConfidence", "probabilities"]) {
				expect(context).not.toContain(privateData)
			}
		}
		h.assertHealthy()
	})

	test("nonzero tool-failure state survives process-style resume and escalates on the next error", async () => {
		const classifier = classifierSequence(classified("trivial"), classified("trivial", false))
		const h = await harness({
			classify: classifier.classify,
			steps: [{ tool: true }, { tool: true }, {}, { tool: true }, {}],
			toolFailures: [true, true, true],
		})
		await h.session.prompt("Fix the failing task")
		expect(customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY).at(-1)?.data).toMatchObject({
			state: { tier: "trivial", failures: 2 },
		})
		const file = h.session.sessionFile
		if (!file) throw new Error("Missing persisted session file")
		h.session.dispose()
		const resumed = await h.open(SessionManager.open(file), true)
		await resumed.prompt("Continue fixing that task")
		expect(routes(h.dispatches)).toEqual([
			["small", "low"],
			["small", "low"],
			["small", "low"],
			["small", "low"],
			["middle", "medium"],
		])
		expect(customEntries(resumed, VIRTUAL_MODEL_STATE_ENTRY).at(-1)?.data).toMatchObject({
			state: { tier: "standard", failures: 0 },
		})
		expect(h.toolExecutions).toBe(3)
		h.assertHealthy()
	})

	test("direct virtual calls use configured strong without classifying, persisting state, or consuming a pending prompt", async () => {
		const classifier = classifierSequence(classified("trivial"), classified("standard", false))
		const boundaryCalls: AssistantMessage[] = []
		const h = await harness({
			classify: classifier.classify,
			steps: [{}, {}, {}, {}, {}],
			extraExtension: (pi) => {
				// Registered after the router: its fresh-run marker is already set.
				pi.on("before_agent_start", async (_event, ctx) => {
					if (!ctx.model) throw new Error("Missing selected model")
					boundaryCalls.push(
						await ctx.modelRegistry
							.streamSimple(ctx.model, {
								messages: [{ role: "user", content: "A direct nested call", timestamp: Date.now() }],
							})
							.result(),
					)
				})
			},
		})
		await h.session.prompt("Initial task")
		expect(classifier.inputs).toHaveLength(1)
		expect(routes(h.dispatches)).toEqual([
			["big", "high"],
			["small", "low"],
		])
		const branch = structuredClone(h.session.sessionManager.getBranch())
		const virtual = requiredModel(h.runtime, ROUTER_PROVIDER, ROUTER_MODEL)
		// Pi 1.1.0 names the public route-resolution API resolveModel.
		const route = await h.runtime.resolveModel(virtual, [], { reason: "direct", thinkingLevel: "off" })
		expect([route.model.provider, route.model.id, route.thinkingLevel]).toEqual([h.providerId, "big", "high"])
		expect(route.state).toBeUndefined()
		const direct = await h.runtime
			.streamSimple(
				virtual,
				{
					messages: [{ role: "user", content: "Direct idle call", timestamp: Date.now() }],
				},
				{ reasoning: "low" },
			)
			.result()
		expect(direct.stopReason).toBe("stop")
		expect(direct.model).toBe("big")
		expect(routes(h.dispatches).at(-1)).toEqual(["big", "high"])
		expect(classifier.inputs).toHaveLength(1)
		expect(h.session.sessionManager.getBranch()).toEqual(branch)
		await h.session.prompt("Fresh follow-up")
		expect(classifier.inputs[1]).toEqual({
			prompt: "Fresh follow-up",
			hasImages: false,
			currentTier: "trivial",
			task: "Initial task",
		})
		expect(routes(h.dispatches)).toEqual([
			["big", "high"],
			["small", "low"],
			["big", "high"],
			["big", "high"],
			["middle", "medium"],
		])
		expect(boundaryCalls.map((message) => [message.model, message.stopReason])).toEqual([
			["big", "stop"],
			["big", "stop"],
		])
		expect(customEntries(h.session, DECISION_ENTRY)).toHaveLength(2)
		expect(customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY)).toHaveLength(2)
		h.assertHealthy()
	})

	test.each(["big", "small"])(
		"a queued follow-up after a failed fresh route retains %s/high, not an older success",
		async (strongModel) => {
			const classifier = classifierSequence(classified("trivial"), classified("strong"))
			const started = gate()
			const release = gate()
			const h = await harness({
				classify: classifier.classify,
				steps: [{}, { started: started.open, wait: release.promise, error: "400 rejected test request" }, {}],
				tiers: {
					trivial: { model: "small", thinking: "low" },
					standard: { model: "middle", thinking: "medium" },
					strong: { model: strongModel, thinking: "high" },
				},
			})
			await h.session.prompt("Old simple task")
			const run = h.session.prompt("New difficult task")
			try {
				await Promise.race([
					started.promise,
					run.then(() => {
						throw new Error("Run ended before queued input")
					}),
				])
				expect(await h.session.followUp("Try that difficult task again")).toBe("queued")
			} finally {
				release.open()
				await run
			}
			await h.session.waitForIdle()
			expect(classifier.inputs).toHaveLength(2)
			expect(routes(h.dispatches)).toEqual([
				["small", "low"],
				[strongModel, "high"],
				[strongModel, "high"],
			])
			expect(customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY).at(-1)?.data).toMatchObject({
				state: { tier: "strong", selection: { provider: h.providerId, model: strongModel, thinking: "high" } },
			})
			h.assertHealthy()
		},
	)

	test("explicit physical pins bypass routing and leave native router state untouched", async () => {
		const classifier = classifierSequence(classified("trivial"), classified("standard", false))
		const h = await harness({ classify: classifier.classify, steps: [{}, {}, {}, {}] })
		await h.session.setModel(requiredModel(h.runtime, h.providerId, "middle"))
		h.session.setThinkingLevel("high")
		await h.session.prompt("Pinned physical task")
		expect(classifier.inputs).toEqual([])
		expect(customEntries(h.session, DECISION_ENTRY)).toEqual([])
		expect(customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY)).toEqual([])

		await h.session.setModel(requiredModel(h.runtime, ROUTER_PROVIDER, ROUTER_MODEL))
		await h.session.prompt("Routed task")
		const state = structuredClone(customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY))
		const decisions = structuredClone(customEntries(h.session, DECISION_ENTRY))
		await h.session.setModel(requiredModel(h.runtime, h.providerId, "big"))
		h.session.setThinkingLevel("low")
		await h.session.prompt("Pinned again")
		expect(classifier.inputs).toHaveLength(1)
		expect(customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY)).toEqual(state)
		expect(customEntries(h.session, DECISION_ENTRY)).toEqual(decisions)
		expect(h.session.model?.provider).toBe(h.providerId)
		expect(h.session.model?.id).toBe("big")
		expect(h.session.thinkingLevel).toBe("low")

		await h.session.setModel(requiredModel(h.runtime, ROUTER_PROVIDER, ROUTER_MODEL))
		await h.session.prompt("Return to routing")
		expect(classifier.inputs[1]).toEqual({
			prompt: "Return to routing",
			hasImages: false,
			currentTier: "trivial",
			task: "Routed task",
		})
		expect(routes(h.dispatches)).toEqual([
			["middle", "high"],
			["small", "low"],
			["big", "low"],
			["middle", "medium"],
		])
		h.assertHealthy()
	})

	test("automatic retries retain the failed physical model and thinking until a fresh idle prompt", async () => {
		const classifier = classifierSequence(classified("standard"), classified("trivial"))
		const h = await harness({
			classify: classifier.classify,
			retry: true,
			steps: [{ error: "429 rate limit exceeded" }, {}, {}],
		})
		const retries: string[] = []
		h.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retries.push(event.type)
		})
		await h.session.prompt("Retry this task")
		await h.session.waitForIdle()
		expect(retries).toEqual(["auto_retry_start"])
		expect(classifier.inputs).toHaveLength(1)
		expect(h.boundaries).toEqual(["Retry this task"])
		expect(routes(h.dispatches)).toEqual([
			["middle", "medium"],
			["middle", "medium"],
		])
		expect(customEntries(h.session, DECISION_ENTRY).at(-1)?.data).toMatchObject({
			reason: "retry",
			action: "retained",
			model: "middle",
			thinking: "medium",
		})
		expect(customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY)).toHaveLength(1)
		await h.session.prompt("A new easy task")
		expect(classifier.inputs).toHaveLength(2)
		expect(routes(h.dispatches).at(-1)).toEqual(["small", "low"])
		h.assertHealthy()
	})

	test("persists classifier error details and endpoint on every failure, outside model context", async () => {
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") })
		const baseUrl = `http://127.0.0.1:${server.port}/v1`
		server.stop(true)
		const h = await harness({
			classifier: { baseUrl, model: "unavailable-local-classifier", timeoutMs: 1000 },
			steps: [{}, {}],
		})
		await h.session.prompt("First task during outage")
		await h.session.prompt("Second task during outage")
		const file = h.session.sessionFile
		if (!file) throw new Error("Missing session file")
		const entries = (await Bun.file(file).text())
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
		const decisions = entries.filter((entry) => entry.type === "custom" && entry.customType === DECISION_ENTRY)
		expect(decisions).toHaveLength(2)
		for (const entry of decisions) {
			expect(entry.data).toMatchObject({
				action: "fallback",
				tier: "strong",
				classifier: {
					baseUrl,
					model: "unavailable-local-classifier",
					timeoutMs: 1000,
					reason: "classifier-error",
					error: { code: "ConnectionRefused" },
				},
			})
			expect(entry.data.classifier.error.message).toContain("connect")
		}
		for (const dispatch of h.dispatches) {
			const context = JSON.stringify(dispatch.context)
			expect(context).not.toContain(baseUrl)
			expect(context).not.toContain("ConnectionRefused")
			expect(context).not.toContain("unavailable-local-classifier")
		}
		h.assertHealthy()
	})

	test("loads from disk without a local Pi SDK, gates low confidence on loopback, and distinguishes invalid answers", async () => {
		const requests: Array<{ method: string; path: string; body: unknown }> = []
		const answers = [
			{
				tier: {
					type: "choice",
					choice: "standard",
					confidence: 0.95,
					probabilities: { trivial: 0.005, standard: 0.99, strong: 0.005 },
				},
				newTask: { type: "noul", noul: 0.9 },
			},
			{
				tier: {
					type: "choice",
					choice: "trivial",
					confidence: 0.51,
					probabilities: { trivial: 0.8, standard: 0.1, strong: 0.1 },
				},
				newTask: { type: "noul", noul: 0.1 },
			},
			{
				// Syntactically valid System One response, but an incomplete tier
				// distribution must not silently select the cheap model.
				tier: { type: "choice", choice: "trivial", confidence: 0.8, probabilities: { trivial: 0.8 } },
				newTask: { type: "noul", noul: 0.9 },
			},
		]
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				requests.push({ method: request.method, path: new URL(request.url).pathname, body: await request.json() })
				return Response.json({ answers: answers.shift(), usage: { input_tokens: 12, output_tokens: 3 } })
			},
		})
		cleanups.push(() => server.stop(true))
		const h = await harness({
			loadFromDisk: true,
			classifier: { baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "local-test-classifier", timeoutMs: 2000 },
			steps: [{}, {}, {}],
		})
		await h.session.prompt("Implement the local task")
		await h.session.prompt("Yes, continue")
		await h.session.prompt("An invalid classification must be safe")
		expect(requests).toHaveLength(3)
		expect(requests.map(({ method, path }) => [method, path])).toEqual([
			["POST", "/v1/systemone"],
			["POST", "/v1/systemone"],
			["POST", "/v1/systemone"],
		])
		expect(requests[0].body).toMatchObject({
			model: "local-test-classifier",
			state: { prompt: "Implement the local task", currentTier: null, establishingTask: null },
			questions: { tier: { type: "choice" }, newTask: { type: "noul" } },
		})
		expect(requests[1].body).toMatchObject({
			state: { prompt: "Yes, continue", currentTier: "standard", establishingTask: "Implement the local task" },
		})
		expect(requests[2].body).toMatchObject({
			state: { currentTier: "strong", establishingTask: "Implement the local task" },
		})
		expect(routes(h.dispatches)).toEqual([
			["middle", "medium"],
			["big", "high"],
			["big", "high"],
		])
		const decisions = customEntries(h.session, DECISION_ENTRY)
		expect(decisions[0].data).toMatchObject({
			action: "classified",
			tier: "standard",
			classifier: {
				kind: "classified",
				model: "local-test-classifier",
				usage: { input: 12, output: 3, totalTokens: 15 },
			},
		})
		expect(decisions[1].data).toMatchObject({
			action: "confidence-gated",
			tier: "strong",
			minConfidence: 0.85,
			classifier: {
				kind: "classified",
				tier: "trivial",
				confidence: 0.51,
				newTask: false,
				probabilities: { trivial: 0.8, standard: 0.1, strong: 0.1 },
			},
		})
		expect(decisions[2].data).toMatchObject({
			action: "fallback",
			tier: "strong",
			classifier: { kind: "fallback", reason: "invalid-answer" },
		})
		expect(customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY).at(-1)?.data).toMatchObject({
			state: { tier: "strong", task: "An invalid classification must be safe" },
		})
		for (const dispatch of h.dispatches) expect(JSON.stringify(dispatch.context)).not.toContain("local-test-classifier")
		h.assertHealthy()
	})
})

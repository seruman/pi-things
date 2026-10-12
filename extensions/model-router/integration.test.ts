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

const ROUTER_NAME = "test"

const ROUTER_MODEL = "auto-test"

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

function classified(tier: Tier, newTask = true, confidence = 0.95, strongProbability?: number): Classification {
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

type Step = { tool?: boolean; wait?: Promise<void>; started?: () => void; error?: string; text?: string }

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
		strongProbabilityThreshold?: number
		minConfidence?: number
		steps?: Step[]
		extraExtension?: ExtensionFactory
		retry?: boolean
		toolFailures?: boolean[]
		tiers?: TestTiers
		configFile?: boolean
		loadFromDisk?: boolean
		captureUI?: boolean
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

		for (const file of ["index.ts", "router.ts", "classifier.ts", "config.ts", "progress.ts", "context.ts"]) {
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
	const widgets: (string[] | undefined)[] = []
	const notifications: string[] = []
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

		if (options.captureUI) {
			const runner = session.extensionRunner
			runner.setUIContext(
				{
					...runner.getUIContext(),
					setWidget(_key, content) {
						if (content !== undefined && !Array.isArray(content)) throw new Error("Expected a text routing widget")
						widgets.push(content)
					},
					notify: (message) => notifications.push(message),
				},
				"tui",
			)
		}

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
		widgets,
		notifications,
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
	test("shows local classification progress before physical dispatch and a brief selected-model result", async () => {
		const started = gate()
		const release = gate()

		const h = await harness({
			captureUI: true,
			classify: async (_config, _input, _registry, signal) => {
				started.open()
				await waitForGate(release.promise, signal)

				return classified("standard")
			},
			steps: [{}],
		})

		const run = h.session.prompt("Fresh task")
		await started.promise
		expect(h.widgets.at(-1)?.[0]).toContain("Routing · local clef-flash:9b-mxfp8 ·")
		expect(h.widgets.at(-1)?.[0]).toContain("/ 10.0s")
		expect(h.dispatches).toEqual([])
		release.open()
		await run
		expect(h.widgets.some((lines) => lines?.[0]?.includes(`Routing complete · ${h.providerId}/middle`))).toBe(true)
		expect(h.widgets.at(-1)).toBeUndefined()
		h.assertHealthy()
	})

	test.each(["timeout", "classifier-error", "invalid-answer"] as const)(
		"shows explicit strong fallback after %s and clears the pending indicator",
		async (reason) => {
			const h = await harness({
				captureUI: true,
				classify: async () => ({ kind: "fallback", reason, durationMs: reason === "timeout" ? 10000 : 5 }),
				steps: [{}],
			})

			await h.session.prompt("Fresh task")

			const expected =
				reason === "timeout" ? "Local classifier timed out; using strong" : "Local classification failed; using strong"

			expect(h.widgets.some((lines) => lines?.[0]?.includes(`${expected} · ${h.providerId}/big`))).toBe(true)
			expect(h.widgets.at(-1)).toBeUndefined()
			expect(h.notifications).toHaveLength(1)
			h.assertHealthy()
		},
	)

	test.each([
		{ label: "standard", strongProbability: 0.5, tier: "strong", model: "big", thinking: "high" },
		{ label: "strong", strongProbability: 0.49, tier: "standard", model: "middle", thinking: "medium" },
	] as const)("reports the probability-routed $tier target rather than the $label label", async (fixture) => {
		const decision = classified(fixture.label, true, 0.99, fixture.strongProbability)
		const h = await harness({ captureUI: true, classify: async () => decision, steps: [{}] })
		await h.session.prompt("Fresh task")
		expect(routes(h.dispatches)).toEqual([[fixture.model, fixture.thinking]])
		expect(
			h.widgets.some((lines) =>
				lines?.[0]?.includes(`Probability threshold; using ${fixture.tier} · ${h.providerId}/${fixture.model}`),
			),
		).toBe(true)
		expect(h.widgets.at(-1)).toBeUndefined()
		expect(customEntries(h.session, DECISION_ENTRY)[0].data).toMatchObject({
			action: "probability-routed",
			tier: fixture.tier,
			probabilityTier: fixture.tier,
			strongProbabilityThreshold: 0.5,
			classifier: decision,
		})
		h.assertHealthy()
	})

	test("cancellation during classification removes the widget without fallback or physical dispatch", async () => {
		const started = gate()

		const h = await harness({
			captureUI: true,
			classify: async (_config, _input, _registry, signal) => {
				started.open()
				await waitForGate(new Promise<void>(() => {}), signal)

				return classified("standard")
			},
		})

		const run = h.session.prompt("Cancel this task")
		await started.promise
		expect(h.widgets.at(-1)?.[0]).toContain("Routing · local")
		await h.session.abort()
		await run
		expect(h.widgets.at(-1)).toBeUndefined()
		expect(h.dispatches).toEqual([])
		expect(h.notifications).toEqual([])
		expect(customEntries(h.session, DECISION_ENTRY)).toEqual([])
		h.assertHealthy()
	})

	test("changing selection clears pending UI and discards even a late classifier result", async () => {
		const started = gate()
		const release = gate()
		let classifySignal: AbortSignal | undefined

		const h = await harness({
			captureUI: true,
			classify: async (_config, _input, _registry, signal) => {
				classifySignal = signal
				started.open()
				// Deliberately ignore cancellation to check stale completion fencing.
				await release.promise

				return classified("standard")
			},
		})

		const run = h.session.prompt("Fresh task")
		await started.promise
		await h.session.setModel(requiredModel(h.runtime, h.providerId, "big"))
		expect(classifySignal?.aborted).toBe(true)
		expect(h.widgets.at(-1)).toBeUndefined()
		release.open()
		await run
		expect(h.widgets.at(-1)).toBeUndefined()
		expect(h.widgets.some((lines) => lines?.[0]?.includes("Routing complete"))).toBe(false)
		expect(customEntries(h.session, DECISION_ENTRY)).toEqual([])
		expect(h.dispatches).toEqual([])
		h.assertHealthy()
	})

	test("unexpected classifier failure still clears progress", async () => {
		const h = await harness({
			captureUI: true,
			classify: async () => {
				throw new Error("unexpected classifier failure")
			},
		})

		await h.session.prompt("Fresh task")
		expect(h.widgets.at(-1)).toBeUndefined()
		expect(h.widgets.some((lines) => lines?.[0]?.includes("Routing · local"))).toBe(true)
		expect(h.dispatches).toEqual([])
		h.assertHealthy()
	})

	test("registers auto-prefixed built-ins without a configuration file or physical requests", async () => {
		const classifier = classifierSequence()
		const h = await harness({ configFile: false, classify: classifier.classify })
		expect(
			h.runtime
				.getAllModels(ROUTER_PROVIDER)
				.map((model) => model.id)
				.sort(),
		).toEqual(["auto-bedrock", "auto-codex"])
		expect((await h.runtime.getAvailable(ROUTER_PROVIDER)).map((model) => model.id).sort()).toEqual([
			"auto-bedrock",
			"auto-codex",
		])

		for (const name of ["codex", "bedrock"]) {
			const id = `auto-${name}`
			expect(requiredModel(h.runtime, ROUTER_PROVIDER, id).name).toBe(`Auto: ${name}`)
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
		const otherRouter = "auto-other"

		const classifier = classifierSequence(
			classified("standard"),
			classified("strong"),
			classified("strong", false),
			classified("standard", false),
			classified("standard", false),
		)

		const h = await harness({
			classify: classifier.classify,
			steps: [{}, {}, {}, {}, {}],
			routers: ({ primary, alternate }) => ({
				[ROUTER_NAME]: {
					tiers: {
						standard: { provider: alternate, model: "middle", thinking: "medium" },
						strong: { provider: primary, model: "big", thinking: "high" },
					},
				},
				other: {
					tiers: {
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
		).toEqual(["auto-bedrock", "auto-codex", otherRouter, ROUTER_MODEL])
		await h.session.prompt("Test router task")

		for (const [name, prompt] of [
			[otherRouter, "Other router task"],
			[ROUTER_MODEL, "Continue test at strong"],
			[otherRouter, "Continue other at standard"],
			[ROUTER_MODEL, "Continue test at standard"],
		]) {
			const beforeSwitch = structuredClone(customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY))
			await h.session.setModel(requiredModel(h.runtime, ROUTER_PROVIDER, name))
			expect(customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY)).toEqual(beforeSwitch)
			await h.session.prompt(prompt)
			expect(h.session.model?.provider).toBe(ROUTER_PROVIDER)
			expect(h.session.model?.id).toBe(name)
			expect(h.session.thinkingLevel).toBe("off")
		}

		expect(classifier.inputs).toMatchObject([
			{ prompt: "Test router task", hasImages: false },
			{ prompt: "Other router task", hasImages: false },
			{ prompt: "Continue test at strong", hasImages: false, currentTier: "standard", task: "Test router task" },
			{ prompt: "Continue other at standard", hasImages: false, currentTier: "strong", task: "Other router task" },
			{ prompt: "Continue test at standard", hasImages: false, currentTier: "strong", task: "Test router task" },
		])
		expect(h.dispatches.map(({ provider, model, thinking }) => [provider, model, thinking])).toEqual([
			[h.alternateProviderId, "middle", "medium"],
			[h.alternateProviderId, "big", "low"],
			[h.providerId, "big", "high"],
			[h.alternateProviderId, "big", "low"],
			[h.providerId, "big", "high"],
		])
		const states = customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY)
		expect(states).toHaveLength(5)

		for (const [index, modelId, tier, task] of [
			[0, ROUTER_MODEL, "standard", "Test router task"],
			[1, otherRouter, "strong", "Other router task"],
			[2, ROUTER_MODEL, "strong", "Test router task"],
			[3, otherRouter, "strong", "Other router task"],
			[4, ROUTER_MODEL, "strong", "Test router task"],
		] as const) {
			const { provider, model, thinking } = h.dispatches[index]
			expect(states[index].data).toMatchObject({
				provider: ROUTER_PROVIDER,
				modelId,
				state: { tier, task, failures: 0, selection: { provider, model, thinking } },
			})
		}

		expect(customEntries(h.session, DECISION_ENTRY).map((entry) => entry.data)).toMatchObject([
			{ router: ROUTER_MODEL },
			{ router: otherRouter },
			{ router: ROUTER_MODEL },
			{ router: otherRouter },
			{ router: ROUTER_MODEL },
		])
		h.assertHealthy()
	})

	test("classifies only fresh idle prompts, not tool continuations or queued steering/follow-ups", async () => {
		const classifier = classifierSequence(classified("standard"), classified("strong", false))
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
			expect(classifier.inputs).toEqual([
				{ prompt: "Implement the original task", hasImages: false, recentConversation: "" },
			])
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
			["middle", "medium"],
			["middle", "medium"],
			["middle", "medium"],
			["middle", "medium"],
		])
		expect(h.session.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
			[{ type: "text", text: "Implement the original task" }],
			[{ type: "text", text: "Use the existing helper" }],
			[{ type: "text", text: "Also check the result" }],
		])
		await h.session.prompt("Now review that implementation")
		expect(classifier.inputs).toEqual([
			{ prompt: "Implement the original task", hasImages: false, recentConversation: "" },
			{
				prompt: "Now review that implementation",
				hasImages: false,
				currentTier: "standard",
				task: "Implement the original task",
				recentConversation: expect.stringContaining("assistant:\ndone"),
			},
		])
		expect(classifier.inputs[1].recentConversation).toContain("user:\nUse the existing helper")
		expect(classifier.inputs[1].recentConversation).toContain("user:\nAlso check the result")
		expect(classifier.inputs[1].recentConversation).toContain("toolResult (probe)")
		expect(classifier.inputs[1].recentConversation).not.toContain("Now review that implementation")
		expect(h.boundaries).toEqual(["Implement the original task", "Now review that implementation"])
		expect(routes(h.dispatches).at(-1)).toEqual(["big", "high"])
		expect(h.dispatches.every((dispatch) => dispatch.provider === h.providerId)).toBe(true)
		expect(h.session.model?.provider).toBe(ROUTER_PROVIDER)
		expect(h.session.model?.id).toBe(ROUTER_MODEL)
		expect(h.session.thinkingLevel).toBe("off")
		h.assertHealthy()
	})

	test("the default follows strong probabilities, including zero confidence, and preserves diagnostic scores", async () => {
		// Synthetic scores exercise policy, not calibrated accuracy.
		const classifier = classifierSequence(
			classified("strong", true, 0.2),
			classified("strong", false, 0.4),
			classified("standard", true, 0),
		)

		const h = await harness({ classify: classifier.classify, steps: [{}, {}, {}] })
		await h.session.prompt("Design a mesh simplification algorithm")
		await h.session.prompt("Implement the proposed algorithm")
		await h.session.prompt("A different simple task")
		expect(routes(h.dispatches)).toEqual([
			["big", "high"],
			["big", "high"],
			["middle", "medium"],
		])
		expect(classifier.inputs[1].currentTier).toBe("strong")
		expect(customEntries(h.session, DECISION_ENTRY).map(({ data }) => data)).toMatchObject([
			{
				action: "classified",
				probabilityTier: "strong",
				strongProbabilityThreshold: 0.5,
				classifier: { tier: "strong", confidence: 0.2 },
			},
			{
				action: "classified",
				probabilityTier: "strong",
				strongProbabilityThreshold: 0.5,
				classifier: { tier: "strong", confidence: 0.4 },
			},
			{
				action: "classified",
				probabilityTier: "standard",
				strongProbabilityThreshold: 0.5,
				classifier: { tier: "standard", confidence: 0 },
			},
		])
		h.assertHealthy()
	})

	test("ignores legacy minConfidence and keeps zero-confidence probabilities authoritative", async () => {
		const classifier = classifierSequence(classified("standard", true, 0), classified("strong", false, 0))
		const h = await harness({ classify: classifier.classify, minConfidence: 1, steps: [{}, {}] })
		await h.session.prompt("A standard task")
		await h.session.prompt("A harder step of the same task")
		expect(routes(h.dispatches)).toEqual([
			["middle", "medium"],
			["big", "high"],
		])
		const decisions = customEntries(h.session, DECISION_ENTRY)

		for (const { data } of decisions) {
			expect(data).not.toHaveProperty("minConfidence")
			expect(data).toMatchObject({
				action: "classified",
				strongProbabilityThreshold: 0.5,
				classifier: { confidence: 0 },
			})
		}

		expect(decisions.map(({ data }) => data)).toMatchObject([
			{ probabilityTier: "standard" },
			{ probabilityTier: "strong" },
		])
		h.assertHealthy()
	})

	test("same-task strong survives resume and branch navigation, while new tasks may downgrade and same tasks may upgrade", async () => {
		const classifier = classifierSequence(
			classified("strong"),
			classified("standard", false),
			classified("standard", true),
			classified("strong", false),
			classified("standard", false),
			classified("standard", false),
		)

		const h = await harness({ classify: classifier.classify, captureUI: true, steps: [{}, {}, {}, {}, {}, {}] })
		await h.session.prompt("Task A: redesign the architecture")
		const strongLeaf = h.session.sessionManager.getLeafId()
		const file = h.session.sessionFile

		if (!strongLeaf || !file) throw new Error("Missing persisted strong branch")
		h.session.dispose()
		const resumed = await h.open(SessionManager.open(file), true)
		await resumed.prompt("Continue task A after resume")
		expect(classifier.inputs[1]).toMatchObject({ currentTier: "strong", task: "Task A: redesign the architecture" })
		expect(customEntries(resumed, DECISION_ENTRY).at(-1)?.data).toMatchObject({
			action: "task-floor",
			tier: "strong",
			probabilityTier: "standard",
			strongProbabilityThreshold: 0.5,
			classifier: { tier: "standard", newTask: false },
		})
		expect(customEntries(resumed, VIRTUAL_MODEL_STATE_ENTRY).at(-1)?.data).toMatchObject({
			state: { tier: "strong", task: "Task A: redesign the architecture" },
		})
		expect(h.widgets.some((lines) => lines?.[0]?.includes(`Same task; keeping strong · ${h.providerId}/big`))).toBe(
			true,
		)
		expect(h.widgets.at(-1)).toBeUndefined()

		await resumed.prompt("Task B: update a label")
		const standardLeaf = resumed.sessionManager.getLeafId()

		if (!standardLeaf) throw new Error("Missing standard branch")
		expect(customEntries(resumed, DECISION_ENTRY).at(-1)?.data).toMatchObject({
			action: "classified",
			tier: "standard",
			probabilityTier: "standard",
			classifier: { newTask: true },
		})
		expect(customEntries(resumed, VIRTUAL_MODEL_STATE_ENTRY).at(-1)?.data).toMatchObject({
			state: { tier: "standard", task: "Task B: update a label" },
		})
		await resumed.prompt("Investigate a harder part of task B")
		expect(classifier.inputs[3]).toMatchObject({ currentTier: "standard", task: "Task B: update a label" })
		expect(customEntries(resumed, DECISION_ENTRY).at(-1)?.data).toMatchObject({
			action: "classified",
			tier: "strong",
			probabilityTier: "strong",
			classifier: { newTask: false },
		})
		expect(customEntries(resumed, VIRTUAL_MODEL_STATE_ENTRY).at(-1)?.data).toMatchObject({
			state: { tier: "strong", task: "Task B: update a label" },
		})

		expect((await resumed.navigateTree(strongLeaf, { summarize: false })).cancelled).toBe(false)
		await resumed.prompt("Continue the original task A branch")
		expect(classifier.inputs[4]).toMatchObject({ currentTier: "strong", task: "Task A: redesign the architecture" })
		expect(customEntries(resumed, DECISION_ENTRY).at(-1)?.data).toMatchObject({
			action: "task-floor",
			tier: "strong",
			probabilityTier: "standard",
		})
		expect((await resumed.navigateTree(standardLeaf, { summarize: false })).cancelled).toBe(false)
		await resumed.prompt("Continue task B before its upgrade")
		expect(classifier.inputs[5]).toMatchObject({ currentTier: "standard", task: "Task B: update a label" })
		expect(customEntries(resumed, DECISION_ENTRY).at(-1)?.data).toMatchObject({
			action: "classified",
			tier: "standard",
			probabilityTier: "standard",
		})
		expect(routes(h.dispatches)).toEqual([
			["big", "high"],
			["big", "high"],
			["middle", "medium"],
			["big", "high"],
			["big", "high"],
			["middle", "medium"],
		])
		h.assertHealthy()
	})

	test("persists native routing state, excludes diagnostics from context, and restores the active branch on resume", async () => {
		const classifier = classifierSequence(
			classified("standard"),
			classified("strong"),
			classified("standard", false),
			classified("strong", false),
			classified("standard", false),
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
			state: { version: 1, tier: "standard", task: "Task A: update a label", failures: 0 },
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
			model: "middle",
			thinking: "medium",
			userEntryId: userA.id,
			classifier: { kind: "classified", probabilities: { standard: 0.99, strong: 0.01 } },
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
			recentConversation: "user:\nTask A: update a label\n\nassistant:\ndone",
			hasImages: false,
			currentTier: "standard",
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
			recentConversation: "user:\nTask A: update a label\n\nassistant:\ndone\n\nuser:\nContinue A\n\nassistant:\ndone",
			hasImages: false,
			currentTier: "standard",
			task: "Task A: update a label",
		})
		expect((await resumed.navigateTree(leafB, { summarize: false })).cancelled).toBe(false)
		expect(customEntries(resumed, VIRTUAL_MODEL_STATE_ENTRY)).toEqual(stateB)
		await resumed.prompt("Continue B")
		expect(classifier.inputs[4]).toEqual({
			prompt: "Continue B",
			recentConversation:
				"user:\nTask A: update a label\n\nassistant:\ndone\n\nuser:\nTask B: redesign the architecture\n\nassistant:\ndone",
			hasImages: false,
			currentTier: "strong",
			task: "Task B: redesign the architecture",
		})
		expect(routes(h.dispatches)).toEqual([
			["middle", "medium"],
			["big", "high"],
			["middle", "medium"],
			["big", "high"],
			["big", "high"],
		])
		expect(customEntries(resumed, DECISION_ENTRY).at(-1)?.data).toMatchObject({
			action: "task-floor",
			probabilityTier: "standard",
			tier: "strong",
			classifier: { tier: "standard", newTask: false },
		})
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

	test.each(["trivial", "standard", "strong"] as const)(
		"resumes version-1 %s state, remapping only the legacy tier's saved selection",
		async (savedTier) => {
			const classifier = classifierSequence(classified("standard"), classified("standard", false))
			const h = await harness({ classify: classifier.classify, steps: [{}, {}, {}] })
			await h.session.prompt("Persisted task")
			const toolCursor = h.session.sessionManager.getLeafId()

			// A removed legacy target must never be resolved. Supported tiers keep
			// their saved provider/model/thinking even when today's mapping differs.
			const savedSelection = {
				provider: h.alternateProviderId,
				model: savedTier === "trivial" ? "removed-legacy-model" : "small",
				thinking: "low",
			}

			h.session.sessionManager.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY, {
				provider: ROUTER_PROVIDER,
				modelId: ROUTER_MODEL,
				state: {
					version: 1,
					tier: savedTier,
					selection: savedSelection,
					task: "Persisted task",
					toolCursor,
					failures: 1,
				},
			})
			const file = h.session.sessionFile

			if (!file) throw new Error("Missing persisted session file")
			h.session.dispose()
			const resumed = await h.open(SessionManager.open(file), true)
			// An extension continuation exercises restoration without a fresh user
			// classification replacing the saved selection first.
			await resumed.sendCustomMessage(
				{ customType: "test.continuation", content: "Continue the persisted task", display: false },
				{ triggerTurn: true },
			)
			const tier = savedTier === "trivial" ? "standard" : savedTier

			const selection =
				savedTier === "trivial" ? { provider: h.providerId, model: "middle", thinking: "medium" } : savedSelection

			expect(classifier.inputs).toHaveLength(1)
			expect(h.dispatches[1]).toMatchObject(selection)
			expect(customEntries(resumed, VIRTUAL_MODEL_STATE_ENTRY).at(-1)?.data).toMatchObject({
				state: { version: 1, tier, selection, task: "Persisted task", toolCursor, failures: 1 },
			})
			expect(customEntries(resumed, DECISION_ENTRY).at(-1)?.data).toMatchObject({
				action: "retained",
				tier,
				...selection,
			})
			await resumed.prompt("Now review the persisted task")
			expect(classifier.inputs[1]).toMatchObject({ currentTier: tier, task: "Persisted task" })
			expect(routes(h.dispatches).at(-1)).toEqual(tier === "strong" ? ["big", "high"] : ["middle", "medium"])
			expect(customEntries(resumed, DECISION_ENTRY).at(-1)?.data).toMatchObject({
				action: tier === "strong" ? "task-floor" : "classified",
				probabilityTier: "standard",
				tier,
			})
			h.assertHealthy()
		},
	)

	test("a configured probability threshold dispatches strong, stays sticky through retries/tools, and persists across resume", async () => {
		const decision = classified("standard", true, 0.89, 0.2)
		const classifier = classifierSequence(decision, classified("standard", true, 0, 0.19))

		const h = await harness({
			classify: classifier.classify,
			strongProbabilityThreshold: 0.2,
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
			action: "probability-routed",
			tier: "strong",
			probabilityTier: "strong",
			strongProbabilityThreshold: 0.2,
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
		await resumed.prompt("A different simple task after resume")
		expect(classifier.inputs[1]).toMatchObject({ currentTier: "strong", task: "Original task" })
		expect(routes(h.dispatches).at(-1)).toEqual(["middle", "medium"])
		expect(customEntries(resumed, VIRTUAL_MODEL_STATE_ENTRY).at(-1)?.data).toMatchObject({
			state: { tier: "standard", task: "A different simple task after resume" },
		})
		expect(customEntries(resumed, DECISION_ENTRY).at(-1)?.data).toMatchObject({
			action: "classified",
			tier: "standard",
			probabilityTier: "standard",
			strongProbabilityThreshold: 0.2,
			classifier: { confidence: 0, probabilities: { strong: 0.19 } },
		})

		for (const dispatch of h.dispatches) {
			const context = JSON.stringify(dispatch.context)

			for (const privateData of [
				DECISION_ENTRY,
				"probability-routed",
				"strongProbabilityThreshold",
				"probabilityTier",
				"probabilities",
			]) {
				expect(context).not.toContain(privateData)
			}
		}

		h.assertHealthy()
	})

	test("nonzero tool-failure state survives process-style resume and escalates on the next error", async () => {
		const classifier = classifierSequence(classified("standard"), classified("standard", false))

		const h = await harness({
			classify: classifier.classify,
			steps: [{ tool: true }, { tool: true }, {}, { tool: true }, {}],
			toolFailures: [true, true, true],
		})

		await h.session.prompt("Fix the failing task")
		expect(customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY).at(-1)?.data).toMatchObject({
			state: { tier: "standard", failures: 2 },
		})
		const file = h.session.sessionFile

		if (!file) throw new Error("Missing persisted session file")
		h.session.dispose()
		const resumed = await h.open(SessionManager.open(file), true)
		await resumed.prompt("Continue fixing that task")
		expect(routes(h.dispatches)).toEqual([
			["middle", "medium"],
			["middle", "medium"],
			["middle", "medium"],
			["middle", "medium"],
			["big", "high"],
		])
		expect(customEntries(resumed, VIRTUAL_MODEL_STATE_ENTRY).at(-1)?.data).toMatchObject({
			state: { tier: "strong", failures: 0 },
		})
		expect(h.toolExecutions).toBe(3)
		h.assertHealthy()
	})

	test("direct virtual calls use configured strong without classifying, persisting state, or consuming a pending prompt", async () => {
		const classifier = classifierSequence(classified("standard"), classified("strong", false))
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
			["middle", "medium"],
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
			recentConversation: "user:\nInitial task\n\nassistant:\ndone",
			hasImages: false,
			currentTier: "standard",
			task: "Initial task",
		})
		expect(routes(h.dispatches)).toEqual([
			["big", "high"],
			["middle", "medium"],
			["big", "high"],
			["big", "high"],
			["big", "high"],
		])
		expect(boundaryCalls.map((message) => [message.model, message.stopReason])).toEqual([
			["big", "stop"],
			["big", "stop"],
		])
		expect(customEntries(h.session, DECISION_ENTRY)).toHaveLength(2)
		expect(customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY)).toHaveLength(2)
		h.assertHealthy()
	})

	test.each(["big", "middle"])(
		"a queued follow-up after a failed fresh route retains %s/high, not an older success",
		async (strongModel) => {
			const classifier = classifierSequence(classified("standard"), classified("strong"))
			const started = gate()
			const release = gate()

			const h = await harness({
				classify: classifier.classify,
				steps: [{}, { started: started.open, wait: release.promise, error: "400 rejected test request" }, {}],
				tiers: {
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
				["middle", "medium"],
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
		const classifier = classifierSequence(classified("standard"), classified("strong", false))
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
			recentConversation:
				"user:\nPinned physical task\n\nassistant:\ndone\n\nuser:\nRouted task\n\nassistant:\ndone\n\nuser:\nPinned again\n\nassistant:\ndone",
			hasImages: false,
			currentTier: "standard",
			task: "Routed task",
		})
		expect(routes(h.dispatches)).toEqual([
			["middle", "high"],
			["middle", "medium"],
			["big", "low"],
			["big", "high"],
		])
		h.assertHealthy()
	})

	test("automatic retries retain the failed physical model and thinking until a fresh idle prompt", async () => {
		const classifier = classifierSequence(classified("strong"), classified("standard"))

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
			["big", "high"],
			["big", "high"],
		])
		expect(customEntries(h.session, DECISION_ENTRY).at(-1)?.data).toMatchObject({
			reason: "retry",
			action: "retained",
			model: "big",
			thinking: "high",
		})
		expect(customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY)).toHaveLength(1)
		await h.session.prompt("A new easy task")
		expect(classifier.inputs).toHaveLength(2)
		expect(routes(h.dispatches).at(-1)).toEqual(["middle", "medium"])
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

	test("native task probabilities retain strong below 0.5 and release the floor at 0.5", async () => {
		const answers = [
			{ tier: "strong", probabilities: { standard: 0.1, strong: 0.9 }, taskProbability: 1 },
			{ tier: "standard", probabilities: { standard: 0.9, strong: 0.1 }, taskProbability: 0.499999 },
			{ tier: "standard", probabilities: { standard: 0.9, strong: 0.1 }, taskProbability: 0.5 },
		]

		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				const answer = answers.shift()

				if (!answer) return new Response("Unexpected classification", { status: 500 })

				return Response.json({
					answers: {
						tier: { type: "choice", choice: answer.tier, probabilities: answer.probabilities, confidence: 0.8 },
						newTask: { type: "noul", noul: answer.taskProbability },
					},
				})
			},
		})

		cleanups.push(() => server.stop(true))

		const h = await harness({
			classifier: { baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "task-boundary", timeoutMs: 2000 },
			steps: [{}, {}, {}],
		})

		await h.session.prompt("Prove the graph algorithm is correct")
		await h.session.prompt("Explain the remaining proof step")
		await h.session.prompt("New task: print the working directory")
		expect(routes(h.dispatches)).toEqual([
			["big", "high"],
			["big", "high"],
			["middle", "medium"],
		])
		expect(customEntries(h.session, VIRTUAL_MODEL_STATE_ENTRY).map(({ data }) => data)).toMatchObject([
			{ state: { task: "Prove the graph algorithm is correct" } },
			{ state: { task: "Prove the graph algorithm is correct" } },
			{ state: { task: "New task: print the working directory" } },
		])
		expect(customEntries(h.session, DECISION_ENTRY).map(({ data }) => data)).toMatchObject([
			{ action: "classified", classifier: { newTask: true } },
			{ action: "task-floor", classifier: { newTask: false } },
			{ action: "classified", classifier: { newTask: true } },
		])
		h.assertHealthy()
	})

	test("loads from disk without a local Pi SDK, routes by probability on loopback, and distinguishes invalid answers", async () => {
		const requests: Array<{ method: string; path: string; body: unknown }> = []

		const answers = [
			{
				tier: {
					type: "choice",
					choice: "standard",
					confidence: 0.95,
					probabilities: { standard: 0.99, strong: 0.01 },
				},
				newTask: { type: "noul", noul: 0.9 },
			},
			{
				tier: {
					type: "choice",
					choice: "standard",
					confidence: 0.51,
					probabilities: { standard: 0.8, strong: 0.2 },
				},
				newTask: { type: "noul", noul: 0.1 },
			},
			{
				// Syntactically valid System One response, but an incomplete tier
				// distribution must not silently select the cheap model.
				tier: { type: "choice", choice: "standard", confidence: 0.8, probabilities: { standard: 0.8 } },
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
			strongProbabilityThreshold: 0.2,
			classifier: { baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "local-test-classifier", timeoutMs: 2000 },
			steps: [{ text: "I propose a two-step migration with rollback." }, {}, {}],
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
			state: {
				latestRequest: "Implement the local task",
				currentTier: null,
				previousTask: null,
				recentConversation: "",
			},
			questions: { tier: { type: "choice" }, newTask: { type: "noul" } },
		})
		expect(requests[0].body).toHaveProperty("questions.tier.criteria", {
			standard: expect.any(String),
			strong: expect.any(String),
		})
		expect(requests[1].body).toMatchObject({
			state: {
				latestRequest: "Yes, continue",
				currentTier: "standard",
				previousTask: "Implement the local task",
				recentConversation:
					"user:\nImplement the local task\n\nassistant:\nI propose a two-step migration with rollback.",
			},
		})
		expect(requests[2].body).toMatchObject({
			state: { currentTier: "strong", previousTask: "Implement the local task" },
		})
		expect(routes(h.dispatches)).toEqual([
			["middle", "medium"],
			["big", "high"],
			["big", "high"],
		])
		const decisions = customEntries(h.session, DECISION_ENTRY)
		expect(JSON.stringify(decisions)).not.toContain("recentConversation")
		expect(JSON.stringify(decisions)).not.toContain("I propose a two-step migration")
		expect(JSON.stringify(decisions)).not.toContain("Yes, continue")
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
			action: "probability-routed",
			tier: "strong",
			probabilityTier: "strong",
			strongProbabilityThreshold: 0.2,
			classifier: {
				kind: "classified",
				tier: "standard",
				confidence: 0.51,
				newTask: false,
				probabilities: { standard: 0.8, strong: 0.2 },
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

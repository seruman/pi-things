import { describe, expect, test } from "bun:test"
import type { Api, Model } from "@earendil-works/pi-ai"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import type { Classification, ClassifyTier, RoutingInput } from "./classifier"
import { type Tier, configSchema } from "./config"
import { ROUTER_PROVIDER, type RouteRequest, type RouterState, type RoutingDecision, createRouter } from "./router"

function required<T>(value: T | undefined | null): T {
	if (value == null) throw new Error("Missing test fixture")

	return value
}

function choice(tier: Tier, newTask = true, confidence = 0.95): Classification {
	return {
		kind: "classified",
		tier,
		newTask,
		probabilities: { standard: 0.01, strong: 0.01, [tier]: 0.99 },
		confidence,
		newTaskProbability: newTask ? 1 : 0,
		durationMs: 5,
	}
}

function harness(classifications: Classification[] = [choice("standard")], threshold = 3) {
	const { routers, ...settings } = configSchema.parse({
		routers: {
			test: {
				tiers: {
					standard: { provider: "physical", model: "middle", thinking: "medium" },
					strong: { provider: "physical", model: "big", thinking: "high" },
				},
			},
		},
		toolFailureThreshold: threshold,
	})

	const config = { ...settings, ...routers.test }

	const models = new Map<string, Model<Api>>(
		Object.values(config.tiers).map(({ model, provider }) => [
			model,
			{
				id: model,
				name: model,
				provider,
				api: "test-api",
				baseUrl: "http://unused.invalid",
				reasoning: true,
				input: ["text"],
				contextWindow: 100_000,
				maxTokens: 4096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		]),
	)

	const sessionManager = SessionManager.inMemory()
	const records: RoutingDecision[] = []
	const inputs: RoutingInput[] = []
	const warnings: string[] = []

	const classify: ClassifyTier = async (_config, input) => {
		inputs.push(input)
		const result = classifications.shift()

		if (!result) throw new Error("Unexpected classification")

		return result
	}

	const ctx = {
		sessionManager,
		hasUI: true,
		mode: "print" as const,
		ui: {
			notify: (message: string) => warnings.push(message),
			setWidget() {
				throw new Error("Print mode must not create terminal widgets")
			},
		},
		modelRegistry: {
			find: (provider: string, id: string) => (provider === models.get(id)?.provider ? models.get(id) : undefined),
			classify: async () => {
				throw new Error("Policy tests must use the supplied classifier")
			},
		},
	}

	const router = createRouter(config, (data) => records.push(data), classify)

	const request: RouteRequest = {
		model: {
			...required(models.get("middle")),
			api: "pi-virtual",
			provider: ROUTER_PROVIDER,
			id: "test",
			name: "Auto",
		},
		thinkingLevel: "off",
		reason: "user",
		messages: [],
	}

	let state: RouterState | undefined
	let previous: RouteRequest["previous"]

	async function route(overrides: Partial<RouteRequest> = {}) {
		const result = await router.route({ ...request, state, previous, ...overrides }, ctx)
		state = result.state ?? state
		previous = { model: result.model, thinkingLevel: result.thinkingLevel }

		return result
	}

	async function fresh(prompt = "Do the task") {
		sessionManager.appendMessage({ role: "user", content: prompt, timestamp: Date.now() })
		router.beginRun(prompt, false)

		return route()
	}

	function tool(isError: boolean) {
		return sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: `call-${sessionManager.getEntries().length}`,
			toolName: "probe",
			content: [{ type: "text", text: isError ? "failed" : "ok" }],
			isError,
			timestamp: Date.now(),
		})
	}

	return {
		config,
		models,
		router,
		route,
		fresh,
		tool,
		records,
		inputs,
		warnings,
		ctx,
		sessionManager,
		request,
		get state() {
			return state
		},
	}
}

describe("model router policy", () => {
	test("uses strong probability, not the choice label or entropy confidence", async () => {
		for (const confidence of [0, 0.15, 1]) {
			const decision = { ...choice("standard", true, confidence), probabilities: { standard: 0.6, strong: 0.4 } }
			const h = harness([decision])
			h.config.strongProbabilityThreshold = 0.3
			const result = await h.fresh()
			expect([result.model.id, result.thinkingLevel]).toEqual(["big", "high"])
			expect(h.state?.tier).toBe("strong")
			expect(h.records[0]).toMatchObject({
				action: "probability-routed",
				tier: "strong",
				probabilityTier: "strong",
				strongProbabilityThreshold: 0.3,
				classifier: decision,
			})
			expect(h.warnings).toEqual([])
		}
	})

	test.each(["standard", "strong"] as const)(
		"follows the selected %s tier regardless of confidence by default",
		async (tier) => {
			for (const confidence of [0, 0.15, 0.3, 0.5, 1]) {
				const h = harness([choice(tier, true, confidence)])
				const result = await h.fresh()
				expect(result.model.id).toBe(h.config.tiers[tier].model)
				expect(result.thinkingLevel).toBe(h.config.tiers[tier].thinking)
				expect(h.state?.tier).toBe(tier)
				expect(h.records[0]).toMatchObject({
					action: "classified",
					tier,
					strongProbabilityThreshold: 0.5,
					classifier: { confidence },
				})
			}
		},
	)

	test("keeps strong selections even at low confidence without claiming an escalation", async () => {
		for (const confidence of [0, 0.15, 0.299999]) {
			const h = harness([choice("strong", true, confidence)])
			const result = await h.fresh()
			expect([result.model.id, result.thinkingLevel]).toEqual(["big", "high"])
			expect(h.records[0]).toMatchObject({ action: "classified", tier: "strong", classifier: { confidence } })
		}
	})

	test.each([
		[0.85, 0.51, "standard"],
		[0.85, 0.85, "strong"],
		[0, 0, "strong"],
		[0.5, 0.499999, "standard"],
		[0.5, 0.5, "strong"],
		[0.5, 0.500001, "strong"],
		[1, 0.999999, "standard"],
		[1, 1, "strong"],
	] as const)("threshold %s with P(strong) %s selects %s", async (strongProbabilityThreshold, strong, tier) => {
		const label = strong >= 0.5 ? "strong" : "standard"
		const decision = { ...choice(label), probabilities: { standard: 1 - strong, strong } }
		const h = harness([decision])
		h.config.strongProbabilityThreshold = strongProbabilityThreshold
		const result = await h.fresh()
		expect(result.model.id).toBe(h.config.tiers[tier].model)
		expect(h.records[0]).toMatchObject({
			action: tier === label ? "classified" : "probability-routed",
			tier,
			probabilityTier: tier,
			strongProbabilityThreshold,
			classifier: decision,
		})
	})

	test.each(["user", "continuation", "retry"] as const)(
		"keeps a probability-routed selection sticky for in-run %s",
		async (reason) => {
			const h = harness([choice("standard", true, 0.15)])
			h.config.strongProbabilityThreshold = 0
			await h.fresh()
			h.tool(true)

			const result = await h.route({
				reason,
				previous: { model: required(h.models.get("middle")), thinkingLevel: "medium" },
			})

			expect([result.model.id, result.thinkingLevel]).toEqual(["big", "high"])
			expect(h.inputs).toHaveLength(1)
			expect(h.records.at(-1)).toMatchObject({ action: "retained", tier: "strong" })
		},
	)

	test("same-task floor retains strong and the task; a new task can downgrade", async () => {
		const h = harness([choice("strong"), choice("standard", false), choice("standard", true)])
		await h.fresh("Investigate feature A")
		h.tool(true)
		await h.route({ reason: "continuation" })
		h.tool(true)
		const result = await h.fresh("try the randomized geometry check")
		expect([result.model.id, result.thinkingLevel]).toEqual(["big", "high"])
		expect(h.state).toMatchObject({ tier: "strong", task: "Investigate feature A", failures: 2 })
		expect(h.records.at(-1)).toMatchObject({
			action: "task-floor",
			tier: "strong",
			probabilityTier: "standard",
			classifier: { newTask: false, tier: "standard" },
		})
		expect((await h.route({ reason: "continuation" })).state).toBeUndefined()
		await h.fresh("Now print the working directory")
		expect(h.inputs[2]).toMatchObject({ currentTier: "strong", task: "Investigate feature A" })
		expect(h.state).toMatchObject({ tier: "standard", task: "Now print the working directory", failures: 0 })
	})

	test("same-task floor permits upward reclassification", async () => {
		const h = harness([choice("standard"), choice("strong", false)])
		await h.fresh("Implement feature A")
		h.tool(true)
		await h.fresh("Account for concurrent retries and partial failure")
		expect(h.state).toMatchObject({ tier: "strong", task: "Implement feature A", failures: 0 })
		expect(h.records.at(-1)).toMatchObject({ action: "classified", tier: "strong" })
	})

	test("a follow-up without saved state has no floor", async () => {
		const h = harness([choice("standard", false)])
		await h.fresh("continue")
		expect(h.state).toMatchObject({ tier: "standard", task: "continue" })
		expect(h.records[0]).toMatchObject({ action: "classified", tier: "standard" })
	})

	test.each(["fallback", "tool-errors"])("same-task floor retains strong after %s", async (source) => {
		const initial: Classification =
			source === "fallback" ? { kind: "fallback", reason: "timeout", durationMs: 1 } : choice("standard")

		const h = harness([initial, choice("standard", false)])
		await h.fresh("Investigate the incident")

		if (source === "tool-errors") {
			for (let i = 0; i < 3; i++) h.tool(true)
			await h.route({ reason: "continuation" })
		}

		await h.fresh("keep going")
		expect(h.state).toMatchObject({ tier: "strong", task: "Investigate the incident" })
		expect(h.records.at(-1)).toMatchObject({ action: "task-floor", tier: "strong" })
	})

	test("keeps establishing task for continuations; replaces it for new tasks even at the same tier", async () => {
		const h = harness([choice("standard"), choice("standard", false), choice("standard", true)])
		await h.fresh("Implement feature A")
		await h.fresh("go ahead")
		expect(h.inputs[1]).toMatchObject({ prompt: "go ahead", currentTier: "standard", task: "Implement feature A" })
		expect(h.state?.task).toBe("Implement feature A")
		await h.fresh("Now implement feature B")
		expect(h.state?.task).toBe("Now implement feature B")
	})

	test.each(["user", "continuation", "retry"] as const)(
		"keeps the saved model and thinking for in-run %s, not an older successful response",
		async (reason) => {
			const h = harness()
			await h.fresh()

			const result = await h.route({
				reason,
				previous: { model: required(h.models.get("middle")), thinkingLevel: "minimal" },
			})

			expect([result.model.id, result.thinkingLevel]).toEqual(["middle", "medium"])
			expect(h.inputs).toHaveLength(1)
			expect(result.state).toBeUndefined()
		},
	)

	test("retry prefers failed route over successful previous, including its thinking level", async () => {
		const h = harness()
		await h.fresh()

		const failed = {
			model: required(h.models.get("big")),
			thinkingLevel: "minimal" as const,
		}

		const result = await h.route({ reason: "retry", failed })
		expect([result.model.id, result.thinkingLevel]).toEqual(["big", "minimal"])
		expect(result.state).toBeUndefined()
		expect(h.inputs).toHaveLength(1)
	})

	test("direct always uses strong and leaves the pending input and decision state alone", async () => {
		const h = harness()
		h.router.beginRun("task", false)
		const direct = await h.route({ reason: "direct" })
		expect([direct.model.id, direct.thinkingLevel]).toEqual(["big", "high"])
		expect(direct.state).toBeUndefined()
		expect(h.records).toHaveLength(0)
		await h.route()
		expect(h.inputs).toHaveLength(1)
		expect(h.state?.tier).toBe("standard")
	})

	test.each(["attachments", "timeout", "classifier-error", "invalid-answer"] as const)(
		"fallback for %s selects strong and records why",
		async (reason) => {
			const h = harness([{ kind: "fallback", reason, durationMs: 5 }])
			const result = await h.fresh()
			expect([result.model.id, result.thinkingLevel]).toEqual(["big", "high"])
			expect(h.records[0]).toMatchObject({ action: "fallback", classifier: { reason } })
		},
	)

	test("warns once per outage, but warns again after a recovery", async () => {
		const failure = { kind: "fallback", reason: "timeout", durationMs: 1 } as const
		const h = harness([failure, failure, choice("standard"), failure])

		for (let i = 0; i < 4; i++) await h.fresh()
		expect(h.warnings).toHaveLength(2)
		expect(h.records).toHaveLength(4)
	})

	test("missing chosen target errors instead of trying another tier", async () => {
		const h = harness()
		h.models.delete("middle")
		await expect(h.fresh()).rejects.toThrow("physical/middle for standard is not in Pi's catalog")
		expect(h.records).toHaveLength(0)
	})

	test("caller cancellation creates neither routing state nor a fallback diagnostic", async () => {
		const h = harness()
		const controller = new AbortController()
		controller.abort()
		h.router.beginRun("task", false)
		await expect(h.route({ signal: controller.signal })).rejects.toThrow()
		expect(h.inputs).toHaveLength(0)
		expect(h.records).toHaveLength(0)
	})

	test("no fresh prompt means no classification even without saved state", async () => {
		const h = harness([])
		const result = await h.route({ reason: "continuation" })
		expect(result.model.id).toBe("big")
		expect(h.inputs).toHaveLength(0)
		expect(h.records[0]).toMatchObject({ action: "no-route" })
	})

	test("reset drops only pending input, not branch state", async () => {
		const h = harness()
		await h.fresh()
		h.router.beginRun("must not classify", false)
		h.router.resetRun()
		await h.route()
		expect(h.inputs).toHaveLength(1)
		expect(h.state?.tier).toBe("standard")
	})
})

describe("persisted routing state", () => {
	// Persisted v1 data predates the current RouterState type.
	function legacyState(toolCursor: string | null, provider = "physical", model = "small") {
		return {
			version: 1,
			tier: "trivial",
			selection: { provider, model, thinking: "low" },
			task: "Implement the original task",
			toolCursor,
			failures: 2,
		} as const
	}

	test.each(["continuation", "user", "retry"] as const)(
		"normalizes legacy trivial state on %s even without other changes or fresh input",
		async (reason) => {
			const h = harness([])
			const legacy = legacyState(h.tool(true))
			const result = await h.route({ reason, state: legacy })
			expect([result.model.id, result.thinkingLevel]).toEqual(["middle", "medium"])
			expect(result.state).toEqual({
				...legacy,
				tier: "standard",
				selection: h.config.tiers.standard,
			})
			expect(h.inputs).toHaveLength(0)
			expect(h.records.at(-1)).toMatchObject({ action: "retained", tier: "standard", previousTier: "standard" })
			// Normalization is persisted once; an unchanged compatible state needs no update.
			expect((await h.route({ reason })).state).toBeUndefined()
		},
	)

	test.each([
		["physical", "small"],
		["anthropic", "claude-haiku-4-5"],
	])("legacy retry ignores failed %s/%s and defers new tool failures", async (provider, model) => {
		const h = harness([])
		const legacy = legacyState(h.tool(true), provider, model)

		const failed = {
			model: { ...required(h.models.get("middle")), provider, id: model },
			thinkingLevel: "low" as const,
		}

		h.tool(true)
		const result = await h.route({ reason: "retry", state: legacy, failed })
		expect([result.model.id, result.thinkingLevel]).toEqual(["middle", "medium"])
		expect(result.state).toEqual({ ...legacy, tier: "standard", selection: h.config.tiers.standard })
		expect(h.inputs).toHaveLength(0)
		const continuation = await h.route({ reason: "continuation" })
		expect([continuation.model.id, continuation.thinkingLevel]).toEqual(["big", "high"])
		expect(continuation.state?.failures).toBe(0)
		expect(h.records.at(-1)).toMatchObject({ action: "escalated", tier: "strong" })
	})

	test("legacy migration uses the currently configured standard selection", async () => {
		const h = harness([])
		h.config.tiers.standard = { provider: "physical", model: "big", thinking: "minimal" }
		const legacy = legacyState(null)
		const result = await h.route({ reason: "continuation", state: legacy })
		expect([result.model.id, result.thinkingLevel]).toEqual(["big", "minimal"])
		expect(result.state).toEqual({ ...legacy, tier: "standard", selection: h.config.tiers.standard })
	})

	test("fresh classifier input receives normalized legacy tier and establishing task", async () => {
		const h = harness([choice("standard", false)])
		const legacy = legacyState(h.tool(true))
		h.router.beginRun("continue", false)
		const result = await h.route({ state: legacy })
		expect(h.inputs).toHaveLength(1)
		expect(h.inputs[0]).toMatchObject({
			prompt: "continue",
			currentTier: "standard",
			task: legacy.task,
		})
		expect([result.model.id, result.thinkingLevel]).toEqual(["middle", "medium"])
		expect(result.state).toEqual({ ...legacy, tier: "standard", selection: h.config.tiers.standard })
	})

	test.each(["standard", "strong"] as const)(
		"keeps saved %s selection authoritative after configuration changes",
		async (tier) => {
			const h = harness([choice(tier)])
			const saved = await h.fresh()
			h.config.tiers[tier] = { ...h.config.tiers[tier === "standard" ? "strong" : "standard"] }

			for (const reason of ["continuation", "user", "retry"] as const) {
				const result = await h.route({ reason })
				expect([result.model.id, result.thinkingLevel]).toEqual([saved.model.id, saved.thinkingLevel])
				expect(result.state).toBeUndefined()
				expect(h.state).toEqual(saved.state)
			}

			expect(h.inputs).toHaveLength(1)
		},
	)
})

describe("tool failure escalation", () => {
	test("three consecutive failures escalate to strong, are not counted twice, and stay at strong", async () => {
		const h = harness()
		await h.fresh()
		h.tool(true)
		h.tool(true)
		expect((await h.route({ reason: "continuation" })).model.id).toBe("middle")
		expect(h.state?.failures).toBe(2)
		h.tool(true)
		expect((await h.route({ reason: "continuation" })).model.id).toBe("big")
		expect(h.state?.failures).toBe(0)
		expect((await h.route({ reason: "continuation" })).state).toBeUndefined()

		for (let i = 0; i < 3; i++) h.tool(true)
		expect((await h.route({ reason: "user" })).model.id).toBe("big")

		for (let i = 0; i < 3; i++) h.tool(true)
		expect((await h.route({ reason: "continuation" })).model.id).toBe("big")
		expect(h.inputs).toHaveLength(1)
		expect(h.records.filter((r) => r.action === "escalated")).toHaveLength(1)
	})

	test("a success resets consecutive failures", async () => {
		const h = harness()
		await h.fresh()

		for (const failed of [true, true, false, true, true]) h.tool(failed)
		expect((await h.route({ reason: "continuation" })).model.id).toBe("middle")
		expect(h.state?.failures).toBe(2)
	})

	test("a batch of six failures escalates directly to strong without replay", async () => {
		const h = harness()
		await h.fresh()

		for (let i = 0; i < 6; i++) h.tool(true)
		expect((await h.route({ reason: "continuation" })).model.id).toBe("big")
		expect(h.state?.failures).toBe(0)
		expect((await h.route({ reason: "continuation" })).state).toBeUndefined()
		expect(h.records.filter((r) => r.action === "escalated")).toHaveLength(1)
	})

	test("custom threshold and compaction do not lose or replay failure counts", async () => {
		const h = harness([choice("standard")], 2)
		await h.fresh()
		h.tool(true)
		await h.route({ reason: "continuation" })
		const manager = h.sessionManager
		manager.appendCompaction("summary", required(manager.getLeafId()), 1000)
		h.tool(true)
		const result = await h.route({ reason: "continuation", messages: [] })
		expect(result.model.id).toBe("big")
		expect((await h.route({ reason: "continuation" })).state).toBeUndefined()
	})

	test("retry does not escalate or consume new failures", async () => {
		const h = harness()
		await h.fresh()

		for (let i = 0; i < 3; i++) h.tool(true)
		expect((await h.route({ reason: "retry" })).model.id).toBe("middle")
		expect(h.state?.failures).toBe(0)
		expect((await h.route({ reason: "continuation" })).model.id).toBe("big")
	})

	test("a fresh continuation escalates directly from standard to strong at the tripwire", async () => {
		const h = harness([choice("standard"), choice("standard", false)])
		await h.fresh("Implement feature A")

		for (let i = 0; i < 3; i++) h.tool(true)
		const result = await h.fresh("continue")
		expect([result.model.id, result.thinkingLevel]).toEqual(["big", "high"])
		expect(h.state).toMatchObject({ tier: "strong", task: "Implement feature A", failures: 0 })
		expect(h.records.at(-1)).toMatchObject({ action: "escalated", tier: "strong" })
	})

	test("an idle continuation of the same task and tier preserves the tripwire", async () => {
		const h = harness([choice("standard"), choice("standard", false)])
		await h.fresh()
		h.tool(true)
		h.tool(true)
		await h.route({ reason: "continuation" })
		await h.fresh("continue")
		h.tool(true)
		expect((await h.route({ reason: "continuation" })).model.id).toBe("big")
		expect(h.state?.failures).toBe(0)
	})
})

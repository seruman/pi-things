import { describe, expect, test } from "bun:test"
import type { Api, Model } from "@earendil-works/pi-ai"
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent"
import type { Classification, ClassifyTier, RoutingInput } from "./classifier"
import { type Tier, configSchema } from "./config"
import { ROUTER_PROVIDER, type RouteRequest, type RouterState, createRouter } from "./router"

function required<T>(value: T | undefined | null): T {
	if (value == null) throw new Error("Missing test fixture")
	return value
}

function choice(tier: Tier, newTask = true, confidence = 0.95): Classification {
	return {
		kind: "classified",
		tier,
		newTask,
		probabilities: { trivial: 0.005, standard: 0.005, strong: 0.005, [tier]: 0.99 },
		confidence,
		newTaskProbability: newTask ? 1 : 0,
		durationMs: 5,
	}
}

function harness(classifications: Classification[] = [choice("trivial")], threshold = 3) {
	const { routers, ...settings } = configSchema.parse({
		routers: {
			test: {
				tiers: {
					trivial: { provider: "physical", model: "small", thinking: "low" },
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
	const records: Record<string, unknown>[] = []
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
		ui: { notify: (message: string) => warnings.push(message) },
		modelRegistry: {
			find: (provider: string, id: string) => (provider === models.get(id)?.provider ? models.get(id) : undefined),
		},
	} as unknown as ExtensionContext
	const router = createRouter(config, (data) => records.push(data), classify)
	const request: RouteRequest = {
		model: {
			...required(models.get("small")),
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
	test.each(["trivial", "standard"] as const)("gates low-confidence %s choices to strong", async (tier) => {
		for (const confidence of [0, 0.15, 0.299999]) {
			const decision = choice(tier, true, confidence)
			const h = harness([decision])
			h.config.minConfidence = 0.3
			const result = await h.fresh()
			expect([result.model.id, result.thinkingLevel]).toEqual(["big", "high"])
			expect(h.state?.tier).toBe("strong")
			expect(h.records[0]).toMatchObject({
				action: "confidence-gated",
				tier: "strong",
				minConfidence: 0.3,
				classifier: decision,
			})
			expect(h.warnings).toEqual([])
		}
	})

	test.each(["trivial", "standard", "strong"] as const)(
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
					minConfidence: 0,
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
		[0.85, 0.51, "strong"],
		[0.85, 0.85, "trivial"],
		[0, 0, "trivial"],
		[0.5, 0.49, "strong"],
		[0.5, 0.5, "trivial"],
		[1, 0.999999, "strong"],
		[1, 1, "trivial"],
	] as const)("threshold %s with confidence %s selects %s", async (minConfidence, confidence, tier) => {
		const h = harness([choice("trivial", true, confidence)])
		h.config.minConfidence = minConfidence
		const result = await h.fresh()
		expect(result.model.id).toBe(h.config.tiers[tier].model)
		expect(h.records[0]).toMatchObject({ tier, minConfidence, classifier: { tier: "trivial", confidence } })
	})

	test.each(["user", "continuation", "retry"] as const)(
		"keeps a gated selection sticky for in-run %s",
		async (reason) => {
			const h = harness([choice("standard", true, 0.15)])
			h.config.minConfidence = 0.3
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

	test("gating preserves the establishing task for a continuation and replaces it for a new task", async () => {
		const h = harness([choice("standard"), choice("trivial", false, 0.15), choice("trivial", true, 0.15)])
		h.config.minConfidence = 0.3
		await h.fresh("Implement feature A")
		await h.fresh("go ahead")
		expect(h.state?.tier).toBe("strong")
		expect(h.state?.task).toBe("Implement feature A")
		await h.fresh("Now implement feature B")
		expect(h.inputs[2]).toMatchObject({ currentTier: "strong", task: "Implement feature A" })
		expect(h.state?.task).toBe("Now implement feature B")
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
				previous: { model: required(h.models.get("small")), thinkingLevel: "minimal" },
			})
			expect([result.model.id, result.thinkingLevel]).toEqual(["small", "low"])
			expect(h.inputs).toHaveLength(1)
			expect(result.state).toBeUndefined()
		},
	)

	test("retry prefers failed route over successful previous, including its thinking level", async () => {
		const h = harness()
		await h.fresh()
		const failed = {
			model: required(h.models.get("middle")),
			thinkingLevel: "high" as const,
			message: {} as NonNullable<RouteRequest["failed"]>["message"],
		}
		const result = await h.route({ reason: "retry", failed })
		expect([result.model.id, result.thinkingLevel]).toEqual(["middle", "high"])
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
		expect(h.state?.tier).toBe("trivial")
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
		h.models.delete("small")
		await expect(h.fresh()).rejects.toThrow("physical/small for trivial is not in Pi's catalog")
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
		expect(h.state?.tier).toBe("trivial")
	})
})

describe("tool failure escalation", () => {
	test("three consecutive failures escalate one tier, are not counted twice, and can escalate again", async () => {
		const h = harness()
		await h.fresh()
		h.tool(true)
		h.tool(true)
		expect((await h.route({ reason: "continuation" })).model.id).toBe("small")
		expect(h.state?.failures).toBe(2)
		h.tool(true)
		expect((await h.route({ reason: "continuation" })).model.id).toBe("middle")
		expect(h.state?.failures).toBe(0)
		expect((await h.route({ reason: "continuation" })).state).toBeUndefined()
		for (let i = 0; i < 3; i++) h.tool(true)
		expect((await h.route({ reason: "user" })).model.id).toBe("big")
		for (let i = 0; i < 3; i++) h.tool(true)
		expect((await h.route({ reason: "continuation" })).model.id).toBe("big")
		expect(h.inputs).toHaveLength(1)
		expect(h.records.filter((r) => r.action === "escalated")).toHaveLength(2)
	})

	test("a success resets consecutive failures", async () => {
		const h = harness()
		await h.fresh()
		for (const failed of [true, true, false, true, true]) h.tool(failed)
		expect((await h.route({ reason: "continuation" })).model.id).toBe("small")
		expect(h.state?.failures).toBe(2)
	})

	test("at most one escalation per batch, even if six tools fail", async () => {
		const h = harness()
		await h.fresh()
		for (let i = 0; i < 6; i++) h.tool(true)
		expect((await h.route({ reason: "continuation" })).model.id).toBe("middle")
		expect((await h.route({ reason: "continuation" })).model.id).toBe("middle")
	})

	test("custom threshold and compaction do not lose or replay failure counts", async () => {
		const h = harness([choice("trivial")], 2)
		await h.fresh()
		h.tool(true)
		await h.route({ reason: "continuation" })
		const manager = h.sessionManager
		manager.appendCompaction("summary", required(manager.getLeafId()), 1000)
		h.tool(true)
		const result = await h.route({ reason: "continuation", messages: [] })
		expect(result.model.id).toBe("middle")
		expect((await h.route({ reason: "continuation" })).state).toBeUndefined()
	})

	test("retry does not escalate or consume new failures", async () => {
		const h = harness()
		await h.fresh()
		for (let i = 0; i < 3; i++) h.tool(true)
		expect((await h.route({ reason: "retry" })).model.id).toBe("small")
		expect(h.state?.failures).toBe(0)
		expect((await h.route({ reason: "continuation" })).model.id).toBe("middle")
	})

	test("an idle continuation of the same task and tier preserves the tripwire", async () => {
		const h = harness([choice("trivial"), choice("trivial", false)])
		await h.fresh()
		h.tool(true)
		h.tool(true)
		await h.route({ reason: "continuation" })
		await h.fresh("continue")
		h.tool(true)
		expect((await h.route({ reason: "continuation" })).model.id).toBe("middle")
		expect(h.state?.failures).toBe(0)
	})
})

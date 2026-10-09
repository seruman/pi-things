import { afterEach, describe, expect, test } from "bun:test"
import { type ClassifierResult, InMemoryCredentialStore } from "@earendil-works/pi-ai"
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent"
import { PROMPT_LIMIT, TASK_LIMIT, classificationContext, classifyTier, parseClassification } from "./classifier"
import { configSchema } from "./config"
import { HISTORY_LIMIT } from "./context"

const registry = new ModelRegistry(
	await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	}),
)

const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true)
})

function serve(handler: (request: Request) => Response | Promise<Response>) {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })
	servers.push(server)
	return { baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "test-classifier", timeoutMs: 2_000 }
}

function valid(): ClassifierResult {
	return {
		api: "typesafe-system-one",
		provider: "test",
		model: "test-classifier",
		timestamp: 0,
		stopReason: "stop",
		answers: {
			tier: {
				type: "choice",
				choice: "standard",
				probabilities: { trivial: 0.2, standard: 0.5, strong: 0.3 },
				confidence: 0.01,
			},
			newTask: { type: "bool", probability: 0.2 },
		},
	}
}

// Ollama System One's wire format; bool is called noul on the wire.
function wire() {
	return {
		answers: {
			tier: {
				type: "choice",
				choice: "standard",
				probabilities: { trivial: 0.2, standard: 0.5, strong: 0.3 },
				confidence: 0.01,
			},
			newTask: { type: "noul", noul: 0.2 },
		},
	}
}

const input = { prompt: "continue", hasImages: false, currentTier: "standard" as const, task: "Build a CLI" }

describe("local classifier", () => {
	test("default deadline allows a cold response beyond the former two-second limit", async () => {
		const endpoint = serve(async () => {
			await Bun.sleep(2100)
			return Response.json(wire())
		})
		const { classifier } = configSchema.parse({ classifier: { baseUrl: endpoint.baseUrl, model: endpoint.model } })
		const result = await classifyTier(classifier, input, registry)
		expect(classifier.timeoutMs).toBe(10000)
		expect(result.kind).toBe("classified")
		expect(result.durationMs).toBeGreaterThanOrEqual(2000)
	})

	test("bounds prompt/task and sends abstract tiers, not physical-model names", () => {
		const context = classificationContext({
			...input,
			prompt: "p".repeat(30_000),
			task: "t".repeat(30_000),
			recentConversation: "h".repeat(30_000),
		})
		expect((context.state.recentConversation as string).length).toBe(HISTORY_LIMIT)
		expect((context.state.prompt as string).length).toBe(PROMPT_LIMIT)
		expect((context.state.establishingTask as string).length).toBe(TASK_LIMIT)
		expect(context.state.currentTier).toBe("standard")
		expect(Object.keys(context.questions)).toEqual(["tier", "newTask"])
		expect(JSON.stringify(context)).not.toContain("gpt")
		expect(JSON.stringify(context)).not.toContain("claude")
	})

	test("native transport sends exactly one local request and preserves a valid low-confidence choice", async () => {
		const requests: { url: string; body: unknown; authorization: string | null }[] = []
		const config = serve(async (request) => {
			requests.push({
				url: request.url,
				body: await request.json(),
				authorization: request.headers.get("authorization"),
			})
			return Response.json(wire())
		})
		const result = await classifyTier(config, input, registry)
		expect(result).toMatchObject({ kind: "classified", tier: "standard", confidence: 0.01, newTask: false })
		expect(requests).toHaveLength(1)
		expect(requests[0].url).toBe(`${config.baseUrl}/systemone`)
		expect(requests[0].authorization).toBe("Bearer local")
		expect(requests[0].body).toMatchObject({
			model: config.model,
			state: { prompt: "continue", establishingTask: "Build a CLI" },
		})
	})

	test.each([429, 500, 503])("HTTP %s falls back without retries", async (status) => {
		let requests = 0
		const config = serve(() => {
			requests++
			return new Response("unavailable", { status })
		})
		expect(await classifyTier(config, input, registry)).toMatchObject({ kind: "fallback", reason: "classifier-error" })
		expect(requests).toBe(1)
	})

	test("a stopped local server records the connection error", async () => {
		const config = serve(() => new Response("unused"))
		servers.at(-1)?.stop(true)
		const result = await classifyTier(config, input, registry)
		expect(result).toMatchObject({
			kind: "fallback",
			reason: "classifier-error",
			error: { code: "ConnectionRefused" },
		})
	})

	test("HTTP errors retain status and a bounded message without echoing prompts or bearer tokens", async () => {
		const config = serve(() =>
			Response.json(
				{ error: `Missing model; Bearer secret-token; ${input.prompt}; ${input.task}; ${"x".repeat(2000)}` },
				{ status: 404 },
			),
		)
		const result = await classifyTier(config, input, registry)
		expect(result).toMatchObject({
			kind: "fallback",
			reason: "classifier-error",
			error: { status: 404 },
		})
		if (result.kind !== "fallback") throw new Error("Expected fallback")
		expect(result.error?.message).toContain("Missing model")
		expect(result.error?.message.length).toBeLessThanOrEqual(1000)
		expect(JSON.stringify(result)).not.toContain(input.prompt)
		expect(JSON.stringify(result)).not.toContain(input.task)
		expect(JSON.stringify(result)).not.toContain("secret-token")
	})

	test("classifier errors redact echoed history and individual transcript lines", async () => {
		const recentConversation = "user:\nPrivate clarification\n\nassistant:\nPrivate proposal"
		const config = serve(() =>
			Response.json({ error: `Rejected ${recentConversation}; Private proposal` }, { status: 500 }),
		)
		const result = await classifyTier(config, { ...input, recentConversation }, registry)
		expect(result).toMatchObject({ kind: "fallback", reason: "classifier-error" })
		expect(JSON.stringify(result)).not.toContain("Private clarification")
		expect(JSON.stringify(result)).not.toContain("Private proposal")
	})

	test("timeout falls back and does not retry", async () => {
		let requests = 0
		const config = serve(async () => {
			requests++
			await Bun.sleep(200)
			return Response.json(wire())
		})
		const result = await classifyTier({ ...config, timeoutMs: 30 }, input, registry)
		expect(result).toMatchObject({
			kind: "fallback",
			reason: "timeout",
			error: { message: "Local classification timed out after 30 ms" },
		})
		expect(result.durationMs).toBeLessThan(500)
		expect(requests).toBe(1)
	})

	test("caller abort propagates instead of routing to strong", async () => {
		const controller = new AbortController()
		let received!: () => void
		const started = new Promise<void>((resolve) => {
			received = resolve
		})
		const config = serve(async () => {
			received()
			await Bun.sleep(100)
			return Response.json(wire())
		})
		const request = classifyTier(config, input, registry, controller.signal)
		await started
		controller.abort(new Error("caller cancelled"))
		await expect(request).rejects.toThrow("caller cancelled")
	})

	test("already cancelled calls and image fallbacks make no HTTP requests", async () => {
		let requests = 0
		const config = serve(() => {
			requests++
			return Response.json(wire())
		})
		expect(await classifyTier(config, { ...input, hasImages: true }, registry)).toMatchObject({
			kind: "fallback",
			reason: "attachments",
		})
		await expect(classifyTier(config, input, registry, AbortSignal.abort(new Error("cancelled")))).rejects.toThrow(
			"cancelled",
		)
		expect(requests).toBe(0)
	})

	test("a redirect cannot forward prompt data to another server", async () => {
		let redirected = 0
		const destination = serve(() => {
			redirected++
			return Response.json(wire())
		})
		const config = serve(
			() => new Response(null, { status: 307, headers: { location: `${destination.baseUrl}/systemone` } }),
		)
		expect(await classifyTier(config, input, registry)).toMatchObject({ kind: "fallback", reason: "classifier-error" })
		expect(redirected).toBe(0)
	})

	test("provider endpoint overrides cannot send prompts outside the configured local endpoint", async () => {
		let requests = 0
		const destination = serve(() => {
			requests++
			return Response.json(wire())
		})
		const config = serve(() => Response.json(wire()))
		const overridden = new ModelRegistry(
			await ModelRuntime.create({
				credentials: new InMemoryCredentialStore(),
				modelsPath: null,
				allowModelNetwork: false,
				refreshOnCreate: false,
			}),
		)
		overridden.registerProvider("typesafe", { baseUrl: destination.baseUrl })
		const result = await classifyTier(config, input, overridden)
		expect(requests).toBe(0)
		expect(result).toMatchObject({ kind: "classified", tier: "standard" })
	})

	test("malformed native responses fall back", async () => {
		const config = serve(() => new Response("not JSON"))
		expect(await classifyTier(config, input, registry)).toMatchObject({ kind: "fallback", reason: "classifier-error" })
	})
})

describe("answer validation", () => {
	test("parsing preserves low confidence for the router to apply its policy", () => {
		expect(parseClassification(valid(), 17)).toMatchObject({
			kind: "classified",
			tier: "standard",
			confidence: 0.01,
			durationMs: 17,
			newTask: false,
		})
	})

	test.each([
		{ type: "choice", choice: "bogus", probabilities: { trivial: 0, standard: 1, strong: 0 }, confidence: 1 },
		{ type: "choice", choice: "standard", probabilities: { standard: 1 }, confidence: 1 },
		{
			type: "choice",
			choice: "standard",
			probabilities: { trivial: 0, standard: Number.NaN, strong: 0 },
			confidence: 1,
		},
		{ type: "choice", choice: "standard", probabilities: { trivial: 0, standard: 1, strong: 0 }, confidence: 2 },
	])("rejects invalid tier answer %#", (tier) => {
		const result = valid()
		result.answers.tier = tier as ClassifierResult["answers"][string]
		expect(parseClassification(result, 0)).toMatchObject({ kind: "fallback", reason: "invalid-answer" })
	})

	test.each([undefined, null, "0.85", -0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"rejects malformed confidence %s rather than treating it as low confidence",
		(confidence) => {
			const result = valid()
			result.answers.tier = { ...result.answers.tier, confidence } as ClassifierResult["answers"][string]
			expect(parseClassification(result, 0)).toMatchObject({ kind: "fallback", reason: "invalid-answer" })
		},
	)

	test("native classifier error messages are preserved rather than replaced by the generic reason", () => {
		const result = {
			...valid(),
			stopReason: "error" as const,
			errorMessage: "System One API did not return an answer for tier",
		}
		expect(parseClassification(result, 7)).toMatchObject({
			kind: "fallback",
			reason: "classifier-error",
			durationMs: 7,
			error: { message: result.errorMessage },
		})
	})

	test("requires a valid task-continuity answer", () => {
		const result = valid()
		result.answers = { tier: result.answers.tier }
		expect(parseClassification(result, 0)).toMatchObject({ kind: "fallback", reason: "invalid-answer" })
	})
})

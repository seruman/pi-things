import { expect, test } from "bun:test"
import { classified, classifierSequence, gate, harness, waitForGate } from "./fixtures/sdk-harness"

// Synthetic cache lifetime/prices exercise Pi's actual scheduler and accounting, not a cloud cache.
test("native idle warming follows physical routing, including unchanged and changed targets", async () => {
	const classifier = classifierSequence(classified("standard"), classified("standard"), classified("strong"))

	const h = await harness({
		classify: classifier.classify,
		settings: { cacheWarming: "idle" },
		modelOverrides: {
			cost: { input: 10, output: 1, cacheRead: 1, cacheWrite: 12 },
			promptCache: { short: 12 },
		},
		usage: {
			input: 0,
			output: 1,
			cacheRead: 100_000,
			cacheWrite: 0,
			totalTokens: 100_001,
			cost: { input: 0, output: 0.000001, cacheRead: 0.1, cacheWrite: 0, total: 0.100001 },
		},
		steps: [{}, {}, {}, {}, {}, {}],
	})

	for (const [index, model] of ["middle", "middle", "big"].entries()) {
		const warmed = gate()

		const unsubscribe = h.session.subscribe((event) => {
			if (event.type === "entry_appended" && event.entry.type === "usage" && event.entry.kind === "cache_warm") {
				warmed.open()
			}
		})

		try {
			await h.session.prompt(`Independent task ${index + 1}`)
			expect(h.session.model?.provider).toBe(h.providerId)
			expect(h.session.model?.id).toBe(model)
			expect(h.session.cacheWarmingStatus).toMatchObject({ state: "scheduled", extensionOverride: false })
			await waitForGate(warmed.promise, AbortSignal.timeout(4500))
			const real = h.dispatches[index * 2]
			const refresh = h.dispatches[index * 2 + 1]
			expect(refresh.model).toBe(model)
			expect(refresh.options.maxTokens).toBe(1)
			expect(refresh.context).toEqual(real.context)
			expect(refresh.options.sessionId).toBe(real.options.sessionId)
			expect(refresh.options.cacheRetention).toBe(real.options.cacheRetention)
		} finally {
			unsubscribe()
		}
	}

	expect(classifier.inputs).toHaveLength(3)
	expect(h.session.sessionManager.getBranch().filter((entry) => entry.type === "usage")).toMatchObject([
		{ kind: "cache_warm", provider: h.providerId, model: "middle", usage: { cacheRead: 100_000 } },
		{ kind: "cache_warm", provider: h.providerId, model: "middle", usage: { cacheRead: 100_000 } },
		{ kind: "cache_warm", provider: h.providerId, model: "big", usage: { cacheRead: 100_000 } },
	])
	h.assertHealthy()
}, 15_000)

test("physical routing does not override native cache lifetime eligibility", async () => {
	const h = await harness({
		classify: async () => classified("standard"),
		settings: { cacheWarming: "idle" },
		steps: [{}],
	})

	await h.session.prompt("A small independent task")
	expect(h.session.model?.id).toBe("middle")
	expect(h.session.cacheWarmingStatus).toMatchObject({ state: "inactive", reason: "cache lifetime unavailable" })
	expect(h.dispatches).toHaveLength(1)
	h.assertHealthy()
})

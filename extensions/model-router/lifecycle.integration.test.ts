import { expect, test } from "bun:test"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import {
	classified,
	classifierSequence,
	customEntries,
	gate,
	harness,
	requiredModel,
	routes,
	waitForGate,
} from "./fixtures/sdk-harness"
import { STATE_ENTRY } from "./index"
import { DECISION_ENTRY } from "./router"

test("fork and reload retain the selected branch task and active preset", async () => {
	const classifier = classifierSequence(classified("strong"), classified("standard"), classified("standard", false))
	const h = await harness({ classify: classifier.classify, steps: [{}, {}, {}] })
	await h.session.prompt("Design a tournament scheduler")
	const original = h.session.sessionManager.getLeafId()

	if (!original) throw new Error("Missing original branch")
	await h.session.prompt("Unrelated: name a primary color")
	const forkFile = h.session.sessionManager.createBranchedSession(original)

	if (!forkFile) throw new Error("Missing forked session")
	const forked = await h.open(SessionManager.open(forkFile), true)
	await forked.reload()
	expect(forked.model?.id).toBe("big")
	expect(forked.thinkingLevel).toBe("high")
	expect([...h.statuses.values()].join(" ")).toContain("router: on")
	await forked.prompt("Continue that design")
	expect(classifier.inputs.at(-1)).toMatchObject({ currentTier: "strong", task: "Design a tournament scheduler" })
	expect(routes(h.dispatches).at(-1)).toEqual(["big", "high"])
	h.assertHealthy()
})

test("off-mode resume respects explicit SDK model and thinking selection", async () => {
	const h = await harness({ enableRouter: false, steps: [{}] })
	await h.session.prompt("An ordinary manual task")
	const file = h.session.sessionManager.getSessionFile()

	if (!file) throw new Error("Expected persistent test session")

	const resumed = await h.open(SessionManager.open(file), true, {
		model: requiredModel(h.runtime, h.alternateProviderId, "middle"),
		thinkingLevel: "low",
	})

	expect(resumed.model?.provider).toBe(h.alternateProviderId)
	expect(resumed.model?.id).toBe("middle")
	expect(resumed.thinkingLevel).toBe("low")
	h.assertHealthy()
})

test("Escape during activation waits for physical model and thinking changes before closing", async () => {
	const selected = gate()
	const release = gate()

	const h = await harness({
		enableRouter: false,
		extraExtension(pi) {
			pi.on("model_select", async (event) => {
				if (event.model.id !== "big") return
				selected.open()
				await release.promise
			})
		},
	})

	await h.configureRouter({ preset: "test" })
	h.session.setThinkingLevel("low")
	const panel = await h.openRouter()
	panel.press("\r")

	try {
		await selected.promise
		panel.press("\x1b")
		await Bun.sleep(0)
		expect(panel.closed).toBe(false)
		expect(h.session.thinkingLevel).toBe("low")
	} finally {
		release.open()
		await panel.result
	}

	expect(panel.closed).toBe(true)
	expect(h.session.model?.id).toBe("big")
	expect(h.session.thinkingLevel).toBe("high")
	expect([...h.statuses.values()].join(" ")).toContain("router: on")
	h.assertHealthy()
})

test("a settled failure from another preset is not treated as the new preset\u0027s retry", async () => {
	const h = await harness({
		classify: async () => classified("standard"),
		steps: [{ error: "400 task failed" }, {}],
		routers: ({ alternate }) => ({
			other: {
				tiers: {
					standard: { provider: alternate, model: "middle", thinking: "medium" },
					strong: { provider: alternate, model: "big", thinking: "high" },
				},
			},
		}),
	})

	await h.session.prompt("An initial task")
	await h.choosePreset("other")
	await h.session.sendCustomMessage(
		{ customType: "test.continuation", content: "Continue with the newly selected preset", display: false },
		{ triggerTurn: true },
	)
	expect(h.dispatches[1]).toMatchObject({ provider: h.alternateProviderId, model: "big", thinking: "high" })
	h.assertHealthy()
})

test("inputs submitted during classification queue inside the active run without reclassification", async () => {
	const started = gate()
	const release = gate()
	const prompts: string[] = []

	const h = await harness({
		classify: async (_config, input, _registry, signal) => {
			prompts.push(input.prompt)
			started.open()
			await waitForGate(release.promise, signal)

			return classified("strong")
		},
		steps: [{}, {}],
	})

	const run = h.session.prompt("Design a board-game scoring engine")
	await started.promise
	expect(h.session.isStreaming).toBe(true)
	await h.session.prompt("Include tied scores", { streamingBehavior: "steer" })
	await h.session.prompt("Then give a small example", { streamingBehavior: "followUp" })
	release.open()
	await run
	expect(prompts).toEqual(["Design a board-game scoring engine"])
	expect(routes(h.dispatches)).toEqual([
		["big", "high"],
		["big", "high"],
	])
	expect(JSON.stringify(h.dispatches[0].context)).toContain("Include tied scores")
	expect(JSON.stringify(h.dispatches[1].context)).toContain("Then give a small example")

	const firstUser = h.session.sessionManager
		.getBranch()
		.find((entry) => entry.type === "message" && entry.message.role === "user")

	expect(customEntries(h.session, DECISION_ENTRY)[0].data).toMatchObject({ userEntryId: firstUser?.id })
	h.assertHealthy()
})

test("branching before a fresh user excludes its task state even though physical selection already changed", async () => {
	const classifier = classifierSequence(classified("strong"), classified("standard"), classified("standard", false))
	const h = await harness({ classify: classifier.classify, steps: [{}, {}, {}] })
	await h.session.prompt("Design a tournament scheduler")
	await h.session.prompt("Unrelated: name a primary color")
	expect(h.session.model?.id).toBe("middle")

	const users = h.session.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "message" && entry.message.role === "user")

	const secondUser = users[1]
	expect(secondUser).toBeDefined()
	await h.session.navigateTree(secondUser.id, { summarize: false })
	expect(h.session.model?.id).toBe("big")
	expect(h.session.thinkingLevel).toBe("high")
	expect(customEntries(h.session, STATE_ENTRY).at(-1)?.data).toMatchObject({
		state: { task: "Design a tournament scheduler" },
	})

	const file = h.session.sessionManager.getSessionFile()

	if (!file) throw new Error("Expected persistent test session")
	const resumed = await h.open(SessionManager.open(file), true)
	await resumed.prompt("Continue that design")
	expect(classifier.inputs.at(-1)).toMatchObject({ currentTier: "strong", task: "Design a tournament scheduler" })
	expect(routes(h.dispatches).at(-1)).toEqual(["big", "high"])
	h.assertHealthy()
})

test.each(["unconfigured", "auth-check-failed"] as const)(
	"%s target selection aborts without stale physical dispatch",
	async (failure) => {
		const h = await harness({
			classify: async () => classified("standard"),
			routers: ({ primary, alternate }) => ({
				alternate: {
					tiers: {
						standard: { provider: alternate, model: "middle", thinking: "medium" },
						strong: { provider: primary, model: "big", thinking: "high" },
					},
				},
			}),
		})

		await h.choosePreset("alternate")
		const provider = h.runtime.getProvider(h.alternateProviderId)

		if (!provider) throw new Error("Missing test provider")
		let failAuth = false
		h.runtime.registerNativeProvider({
			...provider,
			auth: {
				apiKey: {
					name: "Test auth boundary",
					resolve: async () => {
						if (!failAuth) return { auth: {} }

						if (failure === "auth-check-failed") throw new Error("Credential service unavailable")

						return undefined
					},
				},
			},
		})
		await h.runtime.refresh({ allowNetwork: false })
		failAuth = true

		if (failure === "unconfigured") await h.runtime.refresh({ allowNetwork: false })
		await h.session.prompt("Name a primary color")
		expect(h.dispatches).toEqual([])
		expect(customEntries(h.session, STATE_ENTRY)).toEqual([])
		expect(customEntries(h.session, DECISION_ENTRY)).toEqual([])
		expect(h.notifications.some((message) => message.startsWith("model-router:"))).toBe(true)
		h.assertHealthy()
	},
)

import { describe, expect, test } from "bun:test"
import { classified, classifierSequence, gate, harness, routes } from "./fixtures/sdk-harness"

const compactionSettings = { enabled: false, reserveTokens: 1024, keepRecentTokens: 80 }

async function seed(h: Awaited<ReturnType<typeof harness>>) {
	await h.session.prompt(`Old work: ${"investigate parser. ".repeat(200)}`)
	await h.session.prompt(`Recent work: ${"preserve this request. ".repeat(200)}`)
}

describe("physical router summary hooks through the SDK", () => {
	test("manual compaction uses strong/high and preserves standard/medium selection and the kept boundary", async () => {
		const classifier = classifierSequence(classified("standard"), classified("standard"))

		const h = await harness({
			classify: classifier.classify,
			settings: { compaction: compactionSettings },
			steps: [{}, {}, { text: "Checkpoint: continue parser work." }],
		})

		await seed(h)

		const kept = h.session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message")
			.at(-2)

		if (!kept) throw new Error("Missing kept entry")
		const result = await h.session.compact("Keep the parser constraints")

		expect(routes(h.dispatches)).toEqual([
			["middle", "medium"],
			["middle", "medium"],
			["big", "high"],
		])
		expect(h.session.model?.id).toBe("middle")
		expect(h.session.thinkingLevel).toBe("medium")
		expect(result.firstKeptEntryId).toBe(kept.id)
		expect(result.tokensBefore).toBeGreaterThan(0)
		expect(result.summary).toBe("Checkpoint: continue parser work.")
		expect(result.usage?.totalTokens).toBe(2)
		expect(h.session.sessionManager.getLeafEntry()).toMatchObject({
			type: "compaction",
			fromHook: true,
			firstKeptEntryId: kept?.id,
			usage: { totalTokens: 2 },
		})
		expect(h.dispatches[2].options.cacheRetention).toBe("none")
		expect(h.dispatches[2].options.sessionId).toBe(h.session.sessionManager.getSessionId())
		expect(JSON.stringify(h.dispatches[2].context)).toContain("Keep the parser constraints")
		expect(classifier.inputs).toHaveLength(2)
		h.assertHealthy()
	})

	test.each([{ error: "400 invalid summary request" }, { error: "503 Service unavailable" }, { text: "" }])(
		"failed or empty compaction cancels without selected-model fallback: %j",
		async (step) => {
			const h = await harness({
				classify: classifierSequence(classified("standard"), classified("standard")).classify,
				settings: { compaction: compactionSettings },
				steps: [{}, {}, step],
			})

			await seed(h)
			const leaf = h.session.sessionManager.getLeafId()
			await expect(h.session.compact()).rejects.toThrow("Compaction cancelled")
			expect(routes(h.dispatches).slice(2)).toEqual([["big", "high"]])
			expect(h.session.sessionManager.getLeafId()).toBe(leaf)
			expect(h.session.model?.id).toBe("middle")
			expect(h.notifications.some((text) => text.includes("summary cancelled"))).toBe(true)
			h.assertHealthy()
		},
	)

	test("summary retries honor native settings without reclassifying or changing selection", async () => {
		const classifier = classifierSequence(classified("standard"), classified("standard"))

		const h = await harness({
			classify: classifier.classify,
			settings: { compaction: compactionSettings },
			retry: true,
			steps: [{}, {}, { error: "503 Service unavailable" }, { text: "Recovered checkpoint" }],
		})

		await seed(h)
		expect((await h.session.compact()).summary).toBe("Recovered checkpoint")
		expect(routes(h.dispatches).slice(2)).toEqual([
			["big", "high"],
			["big", "high"],
		])
		expect(h.dispatches[2].options.sessionId).toBe(h.dispatches[3].options.sessionId)
		expect(classifier.inputs).toHaveLength(2)
		expect(h.session.model?.id).toBe("middle")
		expect(h.session.thinkingLevel).toBe("medium")
		h.assertHealthy()
	})

	test("aborting compaction cancels its retry and never dispatches a weak summary", async () => {
		const started = gate()

		const h = await harness({
			classify: classifierSequence(classified("standard"), classified("standard")).classify,
			settings: { compaction: compactionSettings, retry: { enabled: true, maxRetries: 3, baseDelayMs: 60_000 } },
			steps: [{}, {}, { error: "503 Service unavailable", started: started.open }],
		})

		await seed(h)
		const leaf = h.session.sessionManager.getLeafId()
		const pending = h.session.compact()
		await started.promise
		h.session.abortCompaction()
		await expect(pending).rejects.toThrow("Compaction cancelled")
		expect(routes(h.dispatches).slice(2)).toEqual([["big", "high"]])
		expect(h.session.sessionManager.getLeafId()).toBe(leaf)
		h.assertHealthy()
	})

	test("successive compactions carry prior hook file details and native file formatting", async () => {
		let checkpoint = true

		const h = await harness({
			classify: classifierSequence(...Array.from({ length: 4 }, () => classified("standard"))).classify,
			settings: { compaction: compactionSettings },
			steps: [{}, {}, {}, { text: "First checkpoint" }, {}, { text: "Second checkpoint" }],
			extraExtension(pi) {
				pi.on("agent_before_settle", () => {
					if (!checkpoint) return
					checkpoint = false

					return {
						entries: [
							{
								type: "compaction",
								summary: "Imported checkpoint",
								firstKeptEntryId: null,
								details: { readFiles: ["src/read.ts", "src/edited.ts"], modifiedFiles: ["src/edited.ts"] },
							},
						],
					}
				})
			},
		})

		await seed(h)
		await h.session.prompt(`Next request: ${"retain new requirements. ".repeat(200)}`)
		const first = await h.session.compact()
		expect(first.details).toEqual({ readFiles: ["src/read.ts"], modifiedFiles: ["src/edited.ts"] })
		expect(JSON.stringify(h.dispatches[3].context)).toContain("Imported checkpoint")
		await h.session.prompt(`Continue: ${"keep recent instructions. ".repeat(200)}`)
		const second = await h.session.compact()
		expect(second.details).toEqual({ readFiles: ["src/read.ts"], modifiedFiles: ["src/edited.ts"] })
		expect(second.summary).toContain("<read-files>\nsrc/read.ts\n</read-files>")
		expect(second.summary).toContain("<modified-files>\nsrc/edited.ts\n</modified-files>")
		expect(h.session.model?.id).toBe("middle")
		h.assertHealthy()
	})

	test("branch summaries use strong/high, instructions, usage, and cumulative hook file details", async () => {
		let first = true

		const h = await harness({
			classify: classifierSequence(classified("standard"), classified("standard"), classified("standard")).classify,
			steps: [{}, {}, { text: "First exploration" }, {}, { text: "Second exploration" }],
			extraExtension(pi) {
				pi.on("session_before_tree", () => {
					if (!first) return
					first = false

					return {
						summary: {
							summary: "Earlier exploration",
							details: { readFiles: ["src/read.ts"], modifiedFiles: ["src/edited.ts"] },
						},
					}
				})
			},
		})

		await seed(h)

		const target = h.session.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant")

		if (!target) throw new Error("Missing branch target")
		expect((await h.session.navigateTree(target.id, { summarize: true })).cancelled).toBe(false)
		await h.session.prompt("Follow up on the explored branch")

		const navigation = await h.session.navigateTree(target.id, {
			summarize: true,
			customInstructions: "Only list parser decisions",
			replaceInstructions: true,
			label: "parser-exploration",
		})

		expect(navigation.cancelled).toBe(false)
		expect(routes(h.dispatches)).toEqual([
			["middle", "medium"],
			["middle", "medium"],
			["big", "high"],
			["middle", "medium"],
			["big", "high"],
		])
		const summary = h.session.sessionManager.getBranch().find((entry) => entry.type === "branch_summary")
		expect(summary).toMatchObject({
			fromHook: true,
			usage: { totalTokens: 2 },
			details: { readFiles: ["src/read.ts"], modifiedFiles: ["src/edited.ts"] },
		})

		if (summary?.type !== "branch_summary") throw new Error("Missing branch summary")
		expect(h.session.sessionManager.getLabel(summary.id)).toBe("parser-exploration")
		expect(summary.summary).toContain("Second exploration")
		expect(summary.summary).toContain("<modified-files>\nsrc/edited.ts\n</modified-files>")

		const request = h.dispatches[4].context.messages
			.flatMap((message) => {
				if (message.role !== "user") return []

				return Array.isArray(message.content)
					? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
					: [message.content]
			})
			.join("\n")

		expect(request.split("</conversation>").at(-1)?.trim()).toBe("Only list parser decisions")
		expect(h.dispatches[4].options).toMatchObject({
			cacheRetention: "none",
			sessionId: h.session.sessionManager.getSessionId(),
		})
		expect(h.session.model?.id).toBe("middle")
		expect(h.session.thinkingLevel).toBe("medium")
		h.assertHealthy()
	})

	test("native overflow recovery summarizes on strong and retries the routed model without reclassification", async () => {
		const classifier = classifierSequence(classified("standard"), classified("standard"), classified("standard"))

		const h = await harness({
			classify: classifier.classify,
			settings: { compaction: { ...compactionSettings, enabled: true } },
			steps: [
				{},
				{},
				{ error: "prompt is too long: 150000 tokens > 128000 maximum" },
				{ text: "Overflow checkpoint" },
				{},
			],
		})

		await seed(h)
		await h.session.prompt("Continue with a new parser task")
		expect(routes(h.dispatches)).toEqual([
			["middle", "medium"],
			["middle", "medium"],
			["middle", "medium"],
			["big", "high"],
			["middle", "medium"],
		])
		expect(classifier.inputs).toHaveLength(3)
		expect(h.session.model?.id).toBe("middle")
		expect(h.session.thinkingLevel).toBe("medium")
		expect(h.session.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toMatchObject([
			{ fromHook: true, summary: "Overflow checkpoint", usage: { totalTokens: 2 } },
		])
		h.assertHealthy()
	})

	test("split-turn compaction preserves both native summaries and their combined usage", async () => {
		const h = await harness({
			classify: classifierSequence(classified("standard"), classified("standard")).classify,
			settings: { compaction: { ...compactionSettings, keepRecentTokens: 0 } },
			steps: [{}, {}, { text: "Historical context" }, { text: "Turn prefix" }],
		})

		await seed(h)
		const result = await h.session.compact()
		expect(result.summary).toContain("Historical context")
		expect(result.summary).toContain("Turn prefix")
		expect(result.usage?.totalTokens).toBe(4)
		expect(routes(h.dispatches).slice(2)).toEqual([
			["big", "high"],
			["big", "high"],
		])
		h.assertHealthy()
	})

	test("disabling the router leaves native selected-model compaction untouched", async () => {
		const h = await harness({
			classify: classifierSequence(classified("standard"), classified("standard")).classify,
			settings: { compaction: compactionSettings },
			steps: [{}, {}, { text: "Native checkpoint" }],
		})

		await seed(h)
		await h.disableRouter()
		expect((await h.session.compact()).summary).toBe("Native checkpoint")
		expect(routes(h.dispatches).slice(2)).toEqual([["middle", "medium"]])
		expect(h.session.sessionManager.getLeafEntry()).toMatchObject({ type: "compaction", fromHook: false })
		h.assertHealthy()
	})

	test("a failed branch summary cancels navigation without weak fallback", async () => {
		const h = await harness({
			classify: classifierSequence(classified("standard"), classified("standard")).classify,
			steps: [{}, {}, { error: "400 invalid summary request" }],
		})

		await seed(h)

		const target = h.session.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant")

		if (!target) throw new Error("Missing branch target")
		const leaf = h.session.sessionManager.getLeafId()
		expect((await h.session.navigateTree(target.id, { summarize: true })).cancelled).toBe(true)
		expect(h.session.sessionManager.getLeafId()).toBe(leaf)
		expect(routes(h.dispatches).slice(2)).toEqual([["big", "high"]])
		h.assertHealthy()
	})
})

import { sessionIdSchema } from "../lib/session-delivery/identity"
import { expect, test } from "bun:test"
import { createSessionMessages } from "./index"
import { listEndpoints, workStatus } from "../lib/session-delivery/mailbox"
import { PoolMailbox as SessionMailbox } from "./fixtures/pool"
import { INCOMING, OUTGOING } from "../lib/session-delivery/ui"
import { sdk, testDirectory, until } from "./fixtures/sdk"
import { gate } from "./fixtures/provider"

async function pair() {
	const root = testDirectory()
	const extension = createSessionMessages({ root, pollMs: 5 })
	const a = await sdk({ root, extension, steps: [{}] })
	const b = await sdk({ root, extension, steps: [{}] })

	return { root, a, b }
}

async function send(h: Awaited<ReturnType<typeof sdk>>, to: string, message: string, delivery = "steer") {
	const tool = h.session.extensionRunner.getToolDefinition("session_send")

	if (!tool) throw new Error("Missing session_send")

	return tool.execute(
		"test-call",
		{ to, message, delivery },
		undefined,
		undefined,
		h.session.extensionRunner.createToolContext("test-call", undefined),
	)
}

test("independent in-process SDK sessions communicate both ways with visible sender and receiver records", async () => {
	const { root, a, b } = await pair()
	expect(listEndpoints(root)).toHaveLength(2)
	expect((await send(a, b.session.sessionId, "question")).isError).not.toBe(true)
	await until(() => b.requests.length === 1)
	await b.session.waitForIdle()
	expect((await send(b, a.session.sessionId, "answer")).isError).not.toBe(true)
	await until(() => a.requests.length === 1)
	await a.session.waitForIdle()

	for (const h of [a, b]) {
		const entries = h.session.sessionManager.getBranch()
		expect(entries.filter((e) => e.type === "custom_message" && e.customType === INCOMING && e.display)).toHaveLength(1)
		expect(entries.filter((e) => e.type === "custom" && e.customType === OUTGOING)).toHaveLength(1)
		expect(JSON.stringify(h.requests)).toContain("Final replies stay in this session")
		expect(JSON.stringify(h.requests)).toContain("Reply target:")
		expect(workStatus({ sessionId: sessionIdSchema.parse(h.session.sessionId) }, root).kind).toBe("idle")
		expect(h.errors).toEqual([])
	}
})

test.each(["mailbox", "ordinary"] as const)(
	"active admissions remain pending; abort is not stale success; %s work recovers",
	async (recovery) => {
		const root = testDirectory()
		const hold = gate()

		const h = await sdk({
			root,
			extension: createSessionMessages({ root, pollMs: 5 }),
			steps: [{}, { wait: hold.promise }, {}],
		})

		await h.session.prompt("old result")
		const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("peer"), cwd: root }, root)
		peer.send(sessionIdSchema.parse(h.session.sessionId), "new work")
		await until(() => h.requests.length === 2)
		expect(workStatus({ sessionId: sessionIdSchema.parse(h.session.sessionId) }, root).kind).toBe("pending")
		await h.session.abort()
		expect(workStatus({ sessionId: sessionIdSchema.parse(h.session.sessionId) }, root).kind).toBe("interrupted")

		if (recovery === "mailbox") peer.send(sessionIdSchema.parse(h.session.sessionId), "fresh work")
		else await h.session.prompt("ordinary work after interruption")
		await until(() => h.requests.length === 3)
		await h.session.waitForIdle()
		expect(workStatus({ sessionId: sessionIdSchema.parse(h.session.sessionId) }, root).kind).toBe("idle")
		expect(h.errors).toEqual([])
	},
)

test.each(["abort", "clear"] as const)(
	"%s before follow-up insertion keeps one visible body and never releases old success",
	async (action) => {
		const root = testDirectory()
		const hold = gate()

		const h = await sdk({
			root,
			extension: createSessionMessages({ root, pollMs: 5 }),
			steps: [{ wait: hold.promise }],
		})

		const running = h.session.prompt("old work")
		await until(() => h.requests.length === 1)
		const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("peer"), cwd: root }, root)
		const message = peer.send(sessionIdSchema.parse(h.session.sessionId), "queued followup", "followUp")
		await until(() => h.session.agent.peekQueuedMessages().length === 1)

		if (action === "clear") {
			h.session.clearQueue()
			hold.open()
		} else await h.session.abort()
		await running
		await h.session.waitForIdle()
		await Bun.sleep(25)

		const entries = h.session.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom_message" && e.customType === INCOMING)

		expect(entries).toHaveLength(0)

		const diagnostics = h.session.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && e.customType === "session-message-error")

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]).toMatchObject({ data: { message: { id: message.id, text: "queued followup" } } })
		expect(workStatus({ sessionId: sessionIdSchema.parse(h.session.sessionId) }, root).kind).toBe("interrupted")
		h.steps.push({}, ...(action === "abort" ? [{}] : []))
		await h.session.prompt("next ordinary prompt")
		await h.session.waitForIdle()
		const count = action === "abort" ? 1 : 0
		expect(JSON.stringify(h.requests.at(-1)).split("queued followup").length - 1).toBe(count)
		expect(
			h.session.sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.customType === INCOMING),
		).toHaveLength(count)
		expect(workStatus({ sessionId: sessionIdSchema.parse(h.session.sessionId) }, root).kind).toBe("idle")
		await h.session.reload()
		expect(
			h.session.sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.customType === INCOMING),
		).toHaveLength(count)
		expect(
			h.session.sessionManager
				.getBranch()
				.filter((e) => e.type === "custom" && e.customType === "session-message-error"),
		).toHaveLength(1)
	},
)

test("startup failure is visible once and reports uncertain interruption rather than success", async () => {
	const root = testDirectory()
	const h = await sdk({ root, selectModel: false, extension: createSessionMessages({ root, pollMs: 5 }) })
	const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("peer"), cwd: root }, root)
	peer.send(sessionIdSchema.parse(h.session.sessionId), "no model")
	await until(() => workStatus({ sessionId: sessionIdSchema.parse(h.session.sessionId) }, root).kind === "interrupted")
	await Bun.sleep(25)
	expect(h.requests).toHaveLength(0)
	expect(
		h.session.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom_message" && e.customType === INCOMING && e.display),
	).toHaveLength(1)
	expect(
		h.session.sessionManager.getBranch().some((e) => e.type === "custom" && e.customType === "session-message-error"),
	).toBe(true)
})

test("duplicate installation handshake is runtime scoped and restricted tools stay restricted", async () => {
	const root = testDirectory()
	const extension = createSessionMessages({ root, pollMs: 5 })

	const h = await sdk({
		root,
		extension: async (pi) => {
			await extension(pi)
			await extension(pi)
		},
		selection: { noTools: "all" },
	})

	expect(listEndpoints(root)).toHaveLength(1)
	expect(
		h.session.extensionRunner.getAllRegisteredTools().filter((t) => t.definition.name === "session_send"),
	).toHaveLength(1)
	expect(h.session.getActiveToolNames()).toEqual([])
	expect(h.session.extensionRunner.getToolDefinition("session_send")?.exposure).toBe("direct")
})

test("public messaging has no implicit parent alias", async () => {
	const { b } = await pair()
	await expect(send(b, "parent", "question")).rejects.toThrow("Offline")
})

test("real SDK reload retires the old instance without replay and keeps exactly one receiver", async () => {
	const root = testDirectory()
	const h = await sdk({ root, extension: createSessionMessages({ root, pollMs: 5 }) })
	const old = listEndpoints(root)[0]

	if (!old) throw new Error("Missing receiver")
	const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("peer"), cwd: root }, root)
	peer.send(sessionIdSchema.parse(h.session.sessionId), "stranded before reload")
	await h.session.reload()
	const current = listEndpoints(root).filter((e) => e.sessionId === h.session.sessionId)
	expect(current).toHaveLength(1)
	expect(current[0]?.instanceId).not.toBe(old.instanceId)
	await Bun.sleep(25)
	expect(h.requests).toHaveLength(0)
	expect(
		workStatus({ sessionId: sessionIdSchema.parse(h.session.sessionId), instanceId: old.instanceId }, root).kind,
	).toBe("interrupted")
})

test("manual compaction holds admission and then delivers once", async () => {
	const root = testDirectory()
	const compact = gate()
	const started = gate()

	const h = await sdk({
		root,
		steps: [{}, {}, {}],
		extension: async (pi) => {
			await createSessionMessages({ root, pollMs: 5 })(pi)
			pi.on("session_before_compact", async (event) => {
				started.open()
				await compact.promise

				return {
					compaction: {
						summary: "test summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}
			})
		},
	})

	await h.session.prompt("old work")
	await h.session.prompt("more work")
	const compacting = h.session.compact()
	await started.promise
	const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("peer"), cwd: root }, root)
	peer.send(sessionIdSchema.parse(h.session.sessionId), "during compact")
	await Bun.sleep(30)
	expect(h.requests).toHaveLength(2)
	expect(workStatus({ sessionId: sessionIdSchema.parse(h.session.sessionId) }, root).kind).toBe("pending")
	compact.open()
	await compacting
	await until(() => h.requests.length === 3)
	await h.session.waitForIdle()
	expect(workStatus({ sessionId: sessionIdSchema.parse(h.session.sessionId) }, root).kind).toBe("idle")
	expect(h.errors).toEqual([])
})

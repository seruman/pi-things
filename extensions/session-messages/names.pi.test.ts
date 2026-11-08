import { sessionIdSchema } from "../lib/session-delivery/identity"
import { expect, test } from "bun:test"
import { createSessionMessages } from "./index"
import { listEndpoints, messageSchema } from "../lib/session-delivery/mailbox"
import { PoolMailbox as SessionMailbox } from "./fixtures/pool"
import { OUTGOING } from "../lib/session-delivery/ui"
import { sdk, testDirectory, until } from "./fixtures/sdk"

test("clearing a session name updates discovery and new envelopes without rewriting history", async () => {
	const root = testDirectory()
	const h = await sdk({ root, extension: createSessionMessages({ root, pollMs: 5 }) })
	const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("peer"), cwd: root }, root)
	h.api.setSessionName("Old name")
	await until(() =>
		listEndpoints(root).some((endpoint) => endpoint.sessionId === h.session.sessionId && endpoint.name === "Old name"),
	)
	const previous = listEndpoints(root).find((endpoint) => endpoint.sessionId === h.session.sessionId)

	if (!previous) throw new Error("Receiver missing")
	const historical = peer.send(sessionIdSchema.parse(h.session.sessionId), "before clearing", "passive")
	h.api.setSessionName("")
	expect(h.session.sessionManager.getSessionName()).toBeUndefined()
	await until(() =>
		listEndpoints(root).some(
			(endpoint) => endpoint.sessionId === h.session.sessionId && endpoint.updatedAt > previous.updatedAt,
		),
	)

	try {
		expect(listEndpoints(root).find((endpoint) => endpoint.sessionId === h.session.sessionId)?.name).toBeUndefined()
		expect(peer.send(sessionIdSchema.parse(h.session.sessionId), "after clearing", "passive").to.name).toBeUndefined()
		expect(historical.to.name).toBe("Old name")
		const tool = h.session.extensionRunner.getToolDefinition("session_send")

		if (!tool) throw new Error("Missing session_send")
		await tool.execute(
			"clear-name",
			{ to: "peer", message: "reply after clearing", delivery: "passive" },
			undefined,
			undefined,
			h.session.extensionRunner.createToolContext("clear-name", undefined),
		)

		const outgoing = h.session.sessionManager
			.getBranch()
			.find((entry) => entry.type === "custom" && entry.customType === OUTGOING)

		if (!outgoing || outgoing.type !== "custom") throw new Error("Missing outgoing entry")
		expect(messageSchema.parse(outgoing.data).from.name).toBeUndefined()
		expect(peer.receive(() => {}).at(0)?.from.name).toBeUndefined()
		expect(h.errors).toEqual([])
	} finally {
		peer.dispose()
	}
})

test("name changes publish without waiting for the periodic heartbeat", async () => {
	const root = testDirectory()
	const h = await sdk({ root, extension: createSessionMessages({ root, pollMs: 60000 }) })
	const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("peer"), cwd: root }, root)
	const endpoint = () => listEndpoints(root).find((entry) => entry.sessionId === h.session.sessionId)

	try {
		h.api.setSessionName("Immediate name")
		await until(() => endpoint()?.name === "Immediate name")
		h.api.setSessionName("")
		const tool = h.session.extensionRunner.getToolDefinition("session_send")

		if (!tool) throw new Error("Missing session_send")
		await tool.execute(
			"immediate-clear",
			{ to: "peer", message: "no old name", delivery: "passive" },
			undefined,
			undefined,
			h.session.extensionRunner.createToolContext("immediate-clear", undefined),
		)
		expect(peer.receive(() => {}).at(0)?.from.name).toBeUndefined()
		await until(() => endpoint()?.name === undefined)
		expect(
			peer.send(sessionIdSchema.parse(h.session.sessionId), "no old recipient name", "passive").to.name,
		).toBeUndefined()
		expect(h.errors).toEqual([])
	} finally {
		peer.dispose()
	}
})

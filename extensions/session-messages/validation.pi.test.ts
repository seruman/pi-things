import { sessionIdSchema } from "../lib/session-delivery/identity"
import { expect, test } from "bun:test"
import { installPendingControls } from "../lib/session-delivery/pending-controls"
import { createSessionMessages } from "./index"
import { PoolMailbox as SessionMailbox } from "./fixtures/pool"
import { sdk, testDirectory } from "./fixtures/sdk"

test("pending commands accept only the documented actions and positive safe decimal integers", async () => {
	const h = await sdk({ extension: (pi) => installPendingControls(pi, () => undefined) })
	const notices: string[] = []
	h.session.extensionRunner.setUIContext(
		{
			...h.session.extensionRunner.createContext().ui,
			notify: (message) => {
				notices.push(message)
			},
		},
		"tui",
	)

	for (const args of [
		"pending more",
		"pending fewer",
		"pending up",
		"pending down",
		"pending top",
		"pending 1",
		"pending 9007199254740991",
		"  pending\t6  ",
	]) {
		await h.session.prompt(`/session-messages ${args}`)
		expect(notices.pop()).toBe("No pending messages")
	}

	for (const args of [
		"",
		"pending",
		"other more",
		"pending more extra",
		"pending 0",
		"pending -0",
		"pending -1",
		"pending +1",
		"pending 01",
		"pending 1.0",
		"pending 1.5",
		"pending 1e3",
		"pending 0x10",
		"pending NaN",
		"pending Infinity",
		"pending 9007199254740992",
		`pending ${"9".repeat(400)}`,
	]) {
		await h.session.prompt(`/session-messages ${args}`)
		expect(notices.pop()).toStartWith("Usage:")
	}

	expect(h.requests).toHaveLength(0)
	expect(h.errors).toEqual([])
})

test("session_send rejects an invalid delivery before publishing a message", async () => {
	const root = testDirectory()
	const h = await sdk({ root, extension: createSessionMessages({ root }) })
	const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("peer"), cwd: root }, root)
	const tool = h.session.extensionRunner.getToolDefinition("session_send")

	if (!tool) throw new Error("Missing session_send")
	const context = h.session.extensionRunner.createToolContext("validation", undefined)

	try {
		await expect(
			tool.execute(
				"validation",
				{ to: "peer", message: "invalid delivery", delivery: "invalid" },
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow()
		expect(peer.receive(() => {})).toEqual([])
		await tool.execute(
			"validation",
			{ to: "peer", message: "valid delivery", delivery: "passive" },
			undefined,
			undefined,
			context,
		)
		expect(peer.receive(() => {}).map((message) => [message.text, message.delivery])).toEqual([
			["valid delivery", "passive"],
		])
		expect(h.requests).toHaveLength(0)
		expect(h.errors).toEqual([])
	} finally {
		peer.dispose()
	}
})

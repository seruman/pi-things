import { expect, test } from "bun:test"
import { acquireDelivery, type DeliveryService } from "../lib/session-delivery/runtime"
import { createSessionMessages } from "./index"
import { sdk, testDirectory } from "./fixtures/sdk"

test("joining does not reactivate unrelated disabled tools under explicit selection", async () => {
	const root = testDirectory()

	const h = await sdk({
		root,
		pool: false,
		selection: { tools: ["probe", "session_list", "session_send"] },
		extension: createSessionMessages({ root }),
	})

	h.api.setActiveTools(h.api.getActiveTools().filter((name) => name !== "probe"))
	await h.session.prompt("/session-messages join one")
	expect(h.api.getActiveTools()).not.toContain("probe")
	expect(h.api.getActiveTools()).toContain("session_send")
	await h.session.prompt("/session-messages leave")
	expect(h.api.getActiveTools()).not.toContain("probe")
	await h.session.prompt("/session-messages join one")
	expect(h.api.getActiveTools()).not.toContain("probe")
})

test("shared service transitions refresh exposure without reactivating tools on pool switches", async () => {
	const root = testDirectory()
	let delivery: DeliveryService | undefined

	const h = await sdk({
		root,
		pool: false,
		extension: async (pi) => {
			await createSessionMessages({ root })(pi)
			delivery = acquireDelivery(pi, { root })
		},
	})

	if (!delivery) throw new Error("Missing delivery")
	delivery.join("one")
	expect(h.api.getActiveTools()).toContain("session_send")
	h.api.setActiveTools(h.api.getActiveTools().filter((name) => name !== "session_send"))
	delivery.join("two")
	expect(h.api.getActiveTools()).not.toContain("session_send")
	delivery.leave()
	expect(h.session.extensionRunner.getToolDefinition("session_send")?.exposure).toBe("hidden")
	delivery.join("one")
	expect(h.api.getActiveTools()).toContain("session_send")
})

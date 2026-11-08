import { sessionIdSchema } from "../lib/session-delivery/identity"
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { gate } from "./fixtures/provider"
import { sdk, testDirectory, until } from "./fixtures/sdk"
import { createSessionMessages } from "./index"
import { admissionSchema, listEndpoints, workStatus } from "../lib/session-delivery/mailbox"
import { PoolMailbox as SessionMailbox } from "./fixtures/pool"
import { DIAGNOSTIC, INCOMING } from "../lib/session-delivery/ui"

function admissions(root: string, sessionId: string) {
	const endpoint = listEndpoints(root).find((e) => e.sessionId === sessionId)

	if (!endpoint) throw new Error("Missing receiver")

	return z
		.object({ admissions: z.record(admissionSchema) })
		.parse(JSON.parse(readFileSync(join(root, endpoint.instanceId, "state.json"), "utf8"))).admissions
}

for (const delivery of ["steer", "followUp", "passive"] as const) {
	test(`real SDK busy ${delivery} preserves tool boundaries`, async () => {
		const hold = gate()
		const h = await sdk({ steps: [{ wait: hold.promise, tool: true }, {}, ...(delivery === "followUp" ? [{}] : [])] })
		const running = h.session.prompt("work")
		await until(() => h.requests.length === 1)
		h.api.sendMessage(
			{ customType: "test-peer", content: "peer-body", display: true },
			{ triggerTurn: delivery !== "passive", deliverAs: delivery === "followUp" ? "followUp" : "steer" },
		)
		expect(h.session.sessionManager.getBranch().some((e) => e.type === "custom_message")).toBe(false)
		hold.open()
		await running
		await h.session.waitForIdle()
		expect(h.requests.length).toBe(delivery === "followUp" ? 3 : 2)
		expect(JSON.stringify(h.requests[1]).includes("peer-body")).toBe(delivery !== "followUp")
		expect(h.session.sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.display)).toHaveLength(1)
		expect(h.errors).toEqual([])
	})
}

test("real SDK idle custom wakes without human prompt; passive does not", async () => {
	const h = await sdk({ steps: [{}] })
	h.api.sendMessage({ customType: "test-peer", content: "passive-body", display: true }, { triggerTurn: false })
	await Bun.sleep(10)
	expect(h.requests).toHaveLength(0)
	h.api.sendMessage({ customType: "test-peer", content: "active-body", display: true }, { triggerTurn: true })
	await until(() => h.requests.length === 1)
	await h.session.waitForIdle()
	expect(h.session.messages.some((m) => m.role === "user")).toBe(false)
	expect(JSON.stringify(h.requests[0])).toContain("passive-body")
	expect(h.errors).toEqual([])
})

for (const action of ["abort", "clear"] as const) {
	test(`busy passive ${action} remains visible once without requiring a response`, async () => {
		const root = testDirectory()
		const hold = gate()

		const h = await sdk({
			root,
			steps: [{ wait: hold.promise }],
			extension: createSessionMessages({ root, pollMs: 5 }),
		})

		const running = h.session.prompt("old task")
		await until(() => h.requests.length === 1)
		const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("peer"), cwd: root }, root)

		const message = peer.send(
			sessionIdSchema.parse(h.session.sessionId),
			"passive body survives cancellation",
			"passive",
		)

		await until(() => admissions(root, h.session.sessionId)[message.id]?.kind === "submitted")
		expect(workStatus({ sessionId: sessionIdSchema.parse(h.session.sessionId) }, root).kind).toBe("idle")

		if (action === "abort") await h.session.abort()
		else {
			h.session.clearQueue()
			hold.open()
		}

		await running
		await until(() => admissions(root, h.session.sessionId)[message.id]?.kind === "settled")
		expect(h.requests).toHaveLength(1)
		expect(JSON.stringify(h.requests)).not.toContain(message.text)
		expect(
			h.session.sessionManager
				.getBranch()
				.filter((e) => e.type === "custom_message" && e.customType === INCOMING && e.display),
		).toHaveLength(1)
		expect(
			h.session.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === DIAGNOSTIC),
		).toHaveLength(0)
		expect(h.errors).toEqual([])
	})
}

test("mixed idle burst drains via Pi without synthetic resends", async () => {
	const root = testDirectory()

	const h = await sdk({
		root,
		steps: Array.from({ length: 12 }, () => ({})),
		extension: createSessionMessages({ root, pollMs: 5 }),
	})

	const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("peer"), cwd: root }, root)

	const messages = Array.from({ length: 10 }, (_, i) =>
		peer.send(sessionIdSchema.parse(h.session.sessionId), `burst-${i}`, i % 2 ? "followUp" : "steer"),
	)

	await until(() => messages.every((m) => admissions(root, h.session.sessionId)[m.id]?.kind === "settled"))
	await h.session.waitForIdle()

	const entries = h.session.sessionManager
		.getBranch()
		.filter((e) => e.type === "custom_message" && e.customType === INCOMING)

	expect(entries).toHaveLength(10)

	for (const message of messages) expect(entries.filter((e) => JSON.stringify(e).includes(message.id))).toHaveLength(1)
	expect(workStatus({ sessionId: sessionIdSchema.parse(h.session.sessionId) }, root).kind).toBe("idle")
	expect(h.errors).toEqual([])
})

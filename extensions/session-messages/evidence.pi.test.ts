import { sessionIdSchema } from "../lib/session-delivery/identity"
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { createSessionMessages } from "./index"
import { admissionSchema, listEndpoints, messageSchema, workStatus } from "../lib/session-delivery/mailbox"
import { PoolMailbox as SessionMailbox } from "./fixtures/pool"
import { INCOMING } from "../lib/session-delivery/ui"
import { sdk, testDirectory, until } from "./fixtures/sdk"

function admission(root: string, sessionId: string, id: string) {
	const endpoint = listEndpoints(root).find((e) => e.sessionId === sessionId)

	if (!endpoint) throw new Error("Missing receiver")

	return z
		.object({ admissions: z.record(admissionSchema) })
		.parse(JSON.parse(readFileSync(join(root, endpoint.instanceId, "state.json"), "utf8"))).admissions[id]
}

for (const transform of ["remove", "redact", "wrong receiver", "quote"] as const) {
	test(`late context hook ${transform} cannot supply canonical inclusion evidence`, async () => {
		const root = testDirectory()

		const h = await sdk({
			root,
			steps: [{}],
			extension: async (pi) => {
				await createSessionMessages({ root, pollMs: 5 })(pi)
				pi.on("context", (event) => ({
					messages: event.messages.flatMap((message) => {
						if (message.role !== "custom" || message.customType !== INCOMING) return [message]

						switch (transform) {
							case "remove":
								return []
							case "redact":
								return [{ ...message, content: "body redacted; details retain the UUID" }]
							case "wrong receiver":
								return [
									{
										...message,
										details: {
											...messageSchema.parse(message.details),
											to: { sessionId: "wrong", instanceId: crypto.randomUUID() },
										},
									},
								]
							case "quote":
								return [
									{
										role: "user",
										content: z.string().parse(message.content),
										timestamp: message.timestamp,
									},
								]
						}
					}),
				}))
			},
		})

		const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("peer"), cwd: root }, root)
		const message = peer.send(sessionIdSchema.parse(h.session.sessionId), "canonical body must be observed")
		await until(() => h.requests.length === 1)
		await h.session.waitForIdle()
		expect(admission(root, h.session.sessionId, message.id)?.kind).toBe("interrupted")
		expect(h.session.getLastAssistantText()).toBe("answer-1")

		if (transform === "remove" || transform === "redact") expect(JSON.stringify(h.requests)).not.toContain(message.text)
		expect(h.requests).toHaveLength(1)
		expect(h.errors).toEqual([])
	})
}

for (const filter of ["first", "retry", "neither"] as const) {
	test(`real automatic retry with ${filter} request filtered correlates only successful inclusion`, async () => {
		const root = testDirectory()
		let request = 0
		let starts = 0
		let settlements = 0

		const h = await sdk({
			root,
			steps: [{ error: true }, {}],
			extension: async (pi) => {
				pi.on("message_end", (event) => {
					if (event.message.role === "assistant" && event.message.stopReason === "error") {
						return { message: { ...event.message, errorMessage: "429 rate limit" } }
					}
				})
				await createSessionMessages({ root, pollMs: 5 })(pi)
				pi.on("agent_start", () => {
					starts++
				})
				pi.on("agent_settled", () => {
					settlements++
				})
				pi.on("context", (event) => {
					request++

					if ((filter === "first" && request === 1) || (filter === "retry" && request === 2)) {
						return { messages: event.messages.filter((m) => m.role !== "custom" || m.customType !== INCOMING) }
					}
				})
			},
		})

		h.session.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } })
		const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("peer"), cwd: root }, root)
		const message = peer.send(sessionIdSchema.parse(h.session.sessionId), "retry inclusion must not leak")
		await until(() => h.requests.length === 2)
		await h.session.waitForIdle()
		expect(starts).toBe(2)
		expect(settlements).toBe(1)
		expect(JSON.stringify(h.requests[0]).includes(message.text)).toBe(filter !== "first")
		expect(JSON.stringify(h.requests[1]).includes(message.text)).toBe(filter !== "retry")
		expect(admission(root, h.session.sessionId, message.id)?.kind).toBe(filter === "retry" ? "interrupted" : "settled")
		expect(workStatus({ sessionId: sessionIdSchema.parse(h.session.sessionId) }, root).kind).toBe(
			filter === "retry" ? "interrupted" : "idle",
		)
		expect(h.errors).toEqual([])
	})
}

for (const error of [false, true]) {
	test(`successful included tool response followed by filtered ${error ? "failure" : "success"} respects final activity outcome`, async () => {
		const root = testDirectory()
		let request = 0

		const h = await sdk({
			root,
			steps: [{ tool: true }, { error }],
			extension: async (pi) => {
				await createSessionMessages({ root, pollMs: 5 })(pi)
				pi.on("context", (event) => {
					if (++request > 1) {
						return { messages: event.messages.filter((m) => m.role !== "custom" || m.customType !== INCOMING) }
					}
				})
			},
		})

		const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("peer"), cwd: root }, root)
		const message = peer.send(sessionIdSchema.parse(h.session.sessionId), "included in successful tool request")
		await until(() => h.requests.length === 2)
		await h.session.waitForIdle()
		expect(JSON.stringify(h.requests[0])).toContain(message.text)
		expect(JSON.stringify(h.requests[1])).not.toContain(message.text)
		expect(admission(root, h.session.sessionId, message.id)?.kind).toBe(error ? "interrupted" : "settled")
		expect(h.errors).toEqual([])
	})
}

test("later context_with_system removal is outside the adapter's observable settlement evidence", async () => {
	const root = testDirectory()

	const h = await sdk({
		root,
		steps: [{}],
		extension: async (pi) => {
			await createSessionMessages({ root, pollMs: 5 })(pi)
			pi.on("context_with_system", (event) => ({
				messages: event.messages.filter((m) => m.role !== "custom" || m.customType !== INCOMING),
			}))
		},
	})

	const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("peer"), cwd: root }, root)
	const message = peer.send(sessionIdSchema.parse(h.session.sessionId), "later transform is unobservable")
	await until(() => h.requests.length === 1)
	await h.session.waitForIdle()
	expect(JSON.stringify(h.requests)).not.toContain(message.text)
	expect(admission(root, h.session.sessionId, message.id)?.kind).toBe("settled")
	expect(h.errors).toEqual([])
})

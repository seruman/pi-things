import { sessionIdSchema } from "../lib/session-delivery/identity"
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { createSessionMessages } from "./index"
import { admissionSchema, listEndpoints, workStatus } from "../lib/session-delivery/mailbox"
import { PoolMailbox as SessionMailbox } from "./fixtures/pool"
import { DIAGNOSTIC, INCOMING } from "../lib/session-delivery/ui"
import { gate } from "./fixtures/provider"
import { sdk, testDirectory, until } from "./fixtures/sdk"

test("agent_end follow-up keeps the activity owner across low-level runs", async () => {
	const root = testDirectory()
	const entered = gate()
	const hold = gate()
	let ends = 0
	let settlements = 0

	const h = await sdk({
		root,
		steps: [{}, {}],
		extension: async (pi) => {
			await createSessionMessages({ root, pollMs: 5 })(pi)
			pi.on("agent_end", async () => {
				if (++ends !== 1) return
				entered.open()
				await hold.promise
			})
			pi.on("agent_settled", () => {
				settlements++
			})
		},
	})

	const running = h.session.prompt("first run")
	await entered.promise
	const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("peer"), cwd: root }, root)
	const message = peer.send(sessionIdSchema.parse(h.session.sessionId), "follow up from agent_end", "followUp")

	try {
		await until(() => admissions(root, h.session.sessionId)[message.id]?.kind === "submitted")
		expect(h.requests).toHaveLength(1)
	} finally {
		hold.open()
	}

	await running
	await h.session.waitForIdle()
	expect(ends).toBe(2)
	expect(settlements).toBe(1)
	expect(JSON.stringify(h.requests[0])).not.toContain(message.text)
	expect(JSON.stringify(h.requests[1])).toContain(message.text)
	expect(admissions(root, h.session.sessionId)[message.id]?.kind).toBe("settled")
	expect(h.errors).toEqual([])
})

function admissions(root: string, sessionId: string) {
	const endpoint = listEndpoints(root).find((e) => e.sessionId === sessionId)

	if (!endpoint) throw new Error("Missing receiver")

	return z
		.object({ admissions: z.record(admissionSchema) })
		.parse(JSON.parse(readFileSync(join(root, endpoint.instanceId, "state.json"), "utf8"))).admissions
}

for (const order of ["before", "after"] as const) {
	for (const delivery of ["steer", "followUp"] as const) {
		test(`slow settled handler ${order} adapter leaves deferred ${delivery} owned by its actual run`, async () => {
			const root = testDirectory()
			const entered = gate()
			const hold = gate()
			const response = gate()
			let first = true

			const h = await sdk({
				root,
				steps: [{}, { wait: response.promise }],
				extension: async (pi) => {
					if (order === "after") await createSessionMessages({ root, pollMs: 5 })(pi)
					pi.on("agent_settled", async () => {
						if (!first) return
						first = false
						entered.open()
						await hold.promise
					})

					if (order === "before") await createSessionMessages({ root, pollMs: 5 })(pi)
				},
			})

			const running = h.session.prompt("old task")
			await entered.promise
			const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("peer"), cwd: root }, root)
			const message = peer.send(sessionIdSchema.parse(h.session.sessionId), "deferred new task", delivery)

			try {
				await until(() => admissions(root, h.session.sessionId)[message.id]?.kind === "submitted")
				await Bun.sleep(80)
				expect(admissions(root, h.session.sessionId)[message.id]?.kind).toBe("submitted")
				expect(workStatus({ sessionId: sessionIdSchema.parse(h.session.sessionId) }, root).kind).toBe("pending")
				expect(h.requests).toHaveLength(1)
				expect(
					h.session.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === DIAGNOSTIC),
				).toHaveLength(0)
			} finally {
				hold.open()
			}

			try {
				await until(() => h.requests.length === 2)
				expect(admissions(root, h.session.sessionId)[message.id]?.kind).toBe("submitted")
				expect(JSON.stringify(h.requests[1])).toContain(message.text)
			} finally {
				response.open()
			}

			await running
			await h.session.waitForIdle()
			expect(admissions(root, h.session.sessionId)[message.id]?.kind).toBe("settled")
			expect(
				h.session.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === DIAGNOSTIC),
			).toHaveLength(0)
			expect(
				h.session.sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.customType === INCOMING),
			).toHaveLength(1)
			expect(h.errors).toEqual([])
		})
	}

	test(`busy submission during a starting hook ${order} adapter binds when consumed`, async () => {
		const root = testDirectory()
		const entered = gate()
		const hold = gate()

		const h = await sdk({
			root,
			steps: [{}, {}],
			extension: async (pi) => {
				if (order === "after") await createSessionMessages({ root, pollMs: 5 })(pi)
				pi.on("before_agent_start", async () => {
					entered.open()
					await hold.promise
				})

				if (order === "before") await createSessionMessages({ root, pollMs: 5 })(pi)
			},
		})

		const running = h.session.prompt("starting task")
		await entered.promise
		const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("peer"), cwd: root }, root)
		const message = peer.send(sessionIdSchema.parse(h.session.sessionId), "during starting hook", "followUp")

		try {
			await until(() => admissions(root, h.session.sessionId)[message.id]?.kind === "submitted")
			expect(h.requests).toHaveLength(0)
		} finally {
			hold.open()
		}

		await running
		await h.session.waitForIdle()
		expect(admissions(root, h.session.sessionId)[message.id]?.kind).toBe("settled")
		expect(h.requests).toHaveLength(2)
		expect(JSON.stringify(h.requests[0])).not.toContain(message.text)
		expect(JSON.stringify(h.requests[1])).toContain(message.text)
		expect(h.errors).toEqual([])
	})
}

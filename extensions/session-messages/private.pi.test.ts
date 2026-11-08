import { relationIdSchema, runHandleSchema, sessionIdSchema } from "../lib/session-delivery/identity"
import { expect, test } from "bun:test"
import { createSessionMessages } from "./index"
import { SessionMailbox, workStatus } from "../lib/session-delivery/mailbox"
import { acquireDelivery, type DeliveryService } from "../lib/session-delivery/runtime"
import { INCOMING } from "../lib/session-delivery/ui"
import { randomUUID } from "node:crypto"
import { copyFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { sdk, testDirectory, until } from "./fixtures/sdk"

async function invoke(h: Awaited<ReturnType<typeof sdk>>, name: string, params = {}) {
	const tool = h.session.extensionRunner.getToolDefinition(name)

	if (!tool) throw new Error(`Missing ${name}`)

	return tool.execute(
		"isolation",
		params,
		undefined,
		undefined,
		h.session.extensionRunner.createToolContext("isolation", undefined),
	)
}

test("loading public messaging does not enroll or expose independent sessions", async () => {
	const root = testDirectory()
	const extension = createSessionMessages({ root, pollMs: 5 })
	const a = await sdk({ root, extension, pool: false })
	await sdk({ root, extension, pool: false })
	const result = await invoke(a, "session_list")
	expect(result.details).toMatchObject({ sessions: [] })
})

test("pool generations revoke queued traffic without poisoning private work status", () => {
	const root = testDirectory()
	const a = new SessionMailbox({ sessionId: sessionIdSchema.parse("a"), cwd: root }, root)
	const b = new SessionMailbox({ sessionId: sessionIdSchema.parse("b"), cwd: root }, root)
	const c = new SessionMailbox({ sessionId: sessionIdSchema.parse("c"), cwd: root }, root)
	a.join("one")
	b.join("one")
	c.join("two")
	expect(
		a
			.peers()
			.map((e) => String(e.sessionId))
			.sort(),
	).toEqual(["a", "b"])
	expect(() => a.send(sessionIdSchema.parse("c"), "foreign")).toThrow("pool")
	const old = b.endpoint.membership
	b.join("one")
	expect(b.endpoint.membership).toEqual(old)
	a.send(sessionIdSchema.parse("b"), "stale")
	const inbox = join(root, b.endpoint.instanceId, "inbox")
	const file = readdirSync(inbox)[0]

	if (!file) throw new Error("Missing envelope")
	copyFileSync(join(inbox, file), join(root, c.endpoint.instanceId, "inbox", file))
	expect(workStatus({ sessionId: sessionIdSchema.parse("c") }, root).kind).toBe("idle")
	expect(c.receive(() => {})).toEqual([])
	b.leave()
	b.join("one")
	expect(b.endpoint.membership).not.toEqual(old)
	expect(workStatus({ sessionId: sessionIdSchema.parse("b") }, root).kind).toBe("idle")
	expect(b.receive(() => {})).toEqual([])
	a.heartbeat("renamed")
	expect(a.endpoint.membership?.pool).toBe("one")
})

test("leaving revokes queued pool traffic but not submitted work or private family traffic", () => {
	const root = testDirectory()
	const policy = () => true
	const a = new SessionMailbox({ sessionId: sessionIdSchema.parse("a"), cwd: root }, root, policy)
	const b = new SessionMailbox({ sessionId: sessionIdSchema.parse("b"), cwd: root }, root, policy)
	a.join("one")
	b.join("one")
	const submitted = a.send(sessionIdSchema.parse("b"), "already submitted")
	b.receive(() => {})
	b.transition(submitted, { kind: "submitted" })
	a.send(sessionIdSchema.parse("b"), "unsubmitted pool")

	const family = a.send(sessionIdSchema.parse("b"), "private", "steer", {
		kind: "family",
		relation: relationIdSchema.parse("00000000-0000-4000-8000-000000000001"),
		handle: runHandleSchema.parse("child"),
		direction: "delegate",
	})

	b.leave()
	a.leave()
	expect(b.receive(() => {}).map((m) => m.id)).toEqual([family.id])
	expect(workStatus({ sessionId: sessionIdSchema.parse("b") }, root, policy).kind).toBe("pending")
	b.transition(family, { kind: "settled" })
	expect(workStatus({ sessionId: sessionIdSchema.parse("b") }, root, policy).kind).toBe("pending")
	b.transition(submitted, { kind: "settled" })
	expect(workStatus({ sessionId: sessionIdSchema.parse("b") }, root, policy).kind).toBe("idle")
})

test.each([true, false])("both adapter orders acquire one private runtime, public first %s", async (publicFirst) => {
	const root = testDirectory()
	const options = { root, pollMs: 5 }

	const h = await sdk({
		root,
		pool: false,
		extension: async (pi) => {
			if (publicFirst) await createSessionMessages(options)(pi)
			const first = acquireDelivery(pi, options)
			await createSessionMessages(options)(pi)
			expect(acquireDelivery(pi, options)).toBe(first)
			expect(() => acquireDelivery(pi, { root, pollMs: 6 })).toThrow("Conflicting")
		},
	})

	expect((await invoke(h, "session_list")).details).toMatchObject({ sessions: [] })
	await h.session.prompt("/session-messages join one")
	expect((await invoke(h, "session_list")).details).toMatchObject({ pool: "one" })
	await h.session.reload()
	expect((await invoke(h, "session_list")).details).toMatchObject({ sessions: [] })
})

test("private model messages keep family authority and completion text without a pool prefix", async () => {
	const root = testDirectory()
	let delivery: DeliveryService | undefined

	const h = await sdk({
		root,
		pool: false,
		extension: (pi) => {
			delivery = acquireDelivery(pi, { root, pollMs: 5 })
			delivery.setFamilyPolicy(() => true)
		},
	})

	const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("peer"), cwd: root }, root, () => true)

	try {
		const relation = relationIdSchema.parse(randomUUID())
		const handle = runHandleSchema.parse("child")

		for (const direction of ["delegate", "reply"] as const) {
			peer.send(sessionIdSchema.parse(h.session.sessionId), `private ${direction}`, "passive", {
				kind: "family",
				direction,
				relation,
				handle,
			})
		}

		const incoming = () =>
			h.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType === INCOMING)

		await until(() => incoming().length === 2)

		if (!delivery) throw new Error("Missing delivery service")
		delivery.stageCompletion({
			route: { kind: "completion", relation, handle, sequence: 1 },
			from: { sessionId: peer.endpoint.sessionId },
			text: "private completion",
			gate: () => "submit",
		})
		await until(() => h.requests.length === 1)
		await h.session.waitForIdle()
		expect(incoming()).toHaveLength(3)

		for (const entry of incoming()) {
			if (entry.type !== "custom_message") throw new Error("Expected custom message")
			const content = String(entry.content)

			const heading = content.endsWith("private delegate")
				? "Delegated task input under existing parent authority"
				: content.endsWith("private reply")
					? "Peer session message"
					: "Subagent completion"

			expect(content).toStartWith(heading + " ")
			expect(content).toContain("\nPrivate family: child\n")
			expect(content).not.toContain("Reply target:")
			expect(JSON.stringify(h.requests)).toContain(heading)
		}

		expect(h.errors).toEqual([])
	} finally {
		peer.dispose()
	}
})

test("a guessed exact session ID cannot bypass explicit membership", async () => {
	const root = testDirectory()
	const extension = createSessionMessages({ root, pollMs: 5 })
	const a = await sdk({ root, extension, pool: false })
	const b = await sdk({ root, extension, pool: false })
	await expect(invoke(a, "session_send", { to: b.session.sessionId, message: "not authorized" })).rejects.toThrow(
		/pool|join|member/i,
	)
	expect(b.requests).toHaveLength(0)
})

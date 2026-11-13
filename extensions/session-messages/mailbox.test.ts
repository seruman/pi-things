import { sessionIdSchema } from "../lib/session-delivery/identity"
import { expect, setSystemTime, test } from "bun:test"
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { listEndpoints, MAX_INBOX, messageSchema, workStatus } from "../lib/session-delivery/mailbox"
import type { Message } from "../lib/session-delivery/mailbox"
import { PoolMailbox as SessionMailbox } from "./fixtures/pool"
import { testDirectory, until } from "./fixtures/sdk"

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false

type AllReadonly<T> = { [K in keyof T]: Equal<Pick<T, K>, Readonly<Pick<T, K>>> }[keyof T]

type Assert<T extends true> = T

type Route = Message["route"]

type RouteReadonly = [
	Assert<Equal<AllReadonly<Extract<Route, { kind: "pool" }>>, true>>,
	Assert<Equal<AllReadonly<Extract<Route, { kind: "family" }>>, true>>,
	Assert<Equal<AllReadonly<Extract<Route, { kind: "completion" }>>, true>>,
]

const routeReadonly: RouteReadonly = [true, true, true]

function pair() {
	const root = testDirectory()

	return {
		root,
		a: new SessionMailbox({ sessionId: sessionIdSchema.parse("a"), cwd: root }, root),
		b: new SessionMailbox({ sessionId: sessionIdSchema.parse("b"), cwd: root }, root),
	}
}

test("live exact instances, ordered unique publication, private files and pending transitions", () => {
	const { root, a, b } = pair()
	const sent = Array.from({ length: 30 }, (_, n) => a.send(sessionIdSchema.parse("b"), `message-${n}`))

	const received = b.receive(() => {
		throw new Error("unexpected diagnostic")
	})

	expect(received.map((m) => m.id)).toEqual(sent.map((m) => m.id))
	expect(Object.isFrozen(received[0])).toBe(true)
	expect(Object.isFrozen(received[0]?.to)).toBe(true)
	const path = join(root, b.endpoint.instanceId)
	expect(statSync(path).mode & 0o777).toBe(0o700)

	for (const name of readdirSync(join(path, "inbox"))) {
		expect(statSync(join(path, "inbox", name)).mode & 0o777).toBe(0o600)
	}

	for (const message of received) b.transition(message, { kind: "submitted" })
	expect(workStatus({ sessionId: sessionIdSchema.parse("b") }, root).kind).toBe("pending")

	for (const message of received) b.transition(message, { kind: "settled" })
	expect(workStatus({ sessionId: sessionIdSchema.parse("b") }, root).kind).toBe("idle")
	expect(() => a.send(sessionIdSchema.parse("a"), "self")).toThrow("Self-send")
	expect(() => a.send(sessionIdSchema.parse("B"), "guess")).toThrow("Offline")
})

test("all parsed message routes are immutable and preserve their wire values", () => {
	const { a } = pair()
	const message = a.send(sessionIdSchema.parse("b"), "route validation")
	const uuid = "1aaf5921-5e85-49da-9508-58d3a82b5df8"

	const routes = [
		message.route,
		{ kind: "family", relation: uuid, handle: "short", direction: "delegate" },
		{ kind: "completion", relation: uuid, handle: "short", sequence: 1 },
	]

	expect(routeReadonly).toEqual([true, true, true])

	for (const route of routes) {
		const parsed = messageSchema.parse({ ...message, route })
		expect(Object.isFrozen(parsed.route)).toBe(true)
		expect(JSON.parse(JSON.stringify(parsed)).route).toEqual(route)
	}
})

test("both message addresses reject malformed fields and remain immutable", () => {
	const { a } = pair()
	const message = a.send(sessionIdSchema.parse("b"), "address validation")
	expect(Object.isFrozen(message.from)).toBe(true)
	expect(Object.isFrozen(message.to)).toBe(true)

	for (const address of [
		{ ...message.from, sessionId: "" },
		{ ...message.from, instanceId: "not-a-uuid" },
		{ ...message.from, name: "x".repeat(257) },
		{ ...message.from, extra: true },
	]) {
		expect(messageSchema.safeParse({ ...message, from: address }).success).toBe(false)
		expect(messageSchema.safeParse({ ...message, to: address }).success).toBe(false)
	}
})

test("periodic keep-alive rewrites the endpoint only when it ages or is renamed", () => {
	const { root, a } = pair()
	const file = join(root, a.endpoint.instanceId, "endpoint.json")
	const inode = () => statSync(file).ino
	const first = inode()
	const started = Date.now()

	try {
		for (let i = 0; i < 20; i++) a.keepAlive(undefined)
		setSystemTime(started + 4000)
		a.keepAlive(undefined)
		expect(inode()).toBe(first)
		a.keepAlive("renamed")
		const renamed = inode()
		expect(renamed).not.toBe(first)
		expect(a.endpoint.name).toBe("renamed")
		setSystemTime(started + 8000)
		a.keepAlive("renamed")
		expect(inode()).toBe(renamed)
		setSystemTime(started + 9500)
		a.keepAlive("renamed")
		expect(inode()).not.toBe(renamed)
		// Refreshed well inside the window peers accept.
		expect(listEndpoints(root).some((endpoint) => endpoint.sessionId === a.endpoint.sessionId)).toBe(true)
	} finally {
		setSystemTime()
	}
})

test("idle polls avoid admission rewrites and outgoing attribution follows rename", () => {
	const { root, a, b } = pair()
	const state = join(root, b.endpoint.instanceId, "state.json")
	const inode = statSync(state).ino
	b.receive(() => {})
	b.receive(() => {})
	expect(statSync(state).ino).toBe(inode)
	a.heartbeat("renamed sender")
	b.heartbeat("renamed recipient")
	const sent = a.send(sessionIdSchema.parse("b"), "hello")
	expect(sent.from.name).toBe("renamed sender")
	expect(sent.to.name).toBe("renamed recipient")
	expect(b.receive(() => {})[0]?.to.name).toBe("renamed recipient")
	expect(a.endpoint.name).toBe("renamed sender")
	a.heartbeat(undefined)
	b.heartbeat(undefined)
	const unnamed = a.send(sessionIdSchema.parse("b"), "after clearing")
	expect(unnamed.from.name).toBeUndefined()
	expect(unnamed.to.name).toBeUndefined()
	expect(listEndpoints(root).map((endpoint) => endpoint.name)).toEqual([undefined, undefined])
	expect(sent.from.name).toBe("renamed sender")
	expect(sent.to.name).toBe("renamed recipient")
})

test("duplicate sessions fail closed; retirement pins wait and never replays", () => {
	const { root, a, b } = pair()
	a.send(sessionIdSchema.parse("b"), "stranded")
	const other = new SessionMailbox({ sessionId: sessionIdSchema.parse("b"), cwd: root }, root)
	expect(() => a.send(sessionIdSchema.parse("b"), "ambiguous")).toThrow("Ambiguous")
	b.dispose()
	expect(workStatus({ sessionId: sessionIdSchema.parse("b"), instanceId: b.endpoint.instanceId }, root).kind).toBe(
		"interrupted",
	)
	expect(other.receive(() => {})).toEqual([])
	other.dispose()
	expect(() => a.send(sessionIdSchema.parse("b"), "offline")).toThrow("Offline")
})

test("malformed and oversized files are diagnosed; passive does not hold joins; fresh success recovers", () => {
	const { root, a, b } = pair()
	const inbox = join(root, b.endpoint.instanceId, "inbox")
	writeFileSync(join(inbox, "bad.json"), "{")
	writeFileSync(join(inbox, "large.json"), "x".repeat(140000))
	const errors: string[] = []
	b.receive((e) => errors.push(e))
	expect(errors).toHaveLength(2)
	expect(workStatus({ sessionId: sessionIdSchema.parse("b") }, root).kind).toBe("idle")
	const good = a.send(sessionIdSchema.parse("b"), "recover")
	b.receive((e) => errors.push(e))
	b.transition(good, { kind: "settled" })
	a.send(sessionIdSchema.parse("b"), "passive", "passive")
	expect(workStatus({ sessionId: sessionIdSchema.parse("b") }, root).kind).toBe("idle")
	expect(() => a.send(sessionIdSchema.parse("b"), "🦊".repeat(5000))).toThrow()
})

test("save failure leaves received files retryable, without half-admitted memory state", () => {
	const { root, a, b } = pair()
	const message = a.send(sessionIdSchema.parse("b"), "retry me")
	const state = join(root, b.endpoint.instanceId, "state.json")
	const saved = readFileSync(state, "utf8")
	renameSync(state, `${state}.backup`)
	mkdirSync(state)
	expect(() => b.receive(() => {})).toThrow()
	renameSync(state, `${state}.directory`)
	writeFileSync(state, saved)
	expect(b.receive(() => {}).map((m) => m.id)).toEqual([message.id])
})

test("separate processes discover, publish and reply through instance-owned mailboxes", async () => {
	const root = testDirectory()
	const a = new SessionMailbox({ sessionId: sessionIdSchema.parse("process-parent"), cwd: root }, root)

	const peer = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/process-peer.ts"), root], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "pipe",
	})

	try {
		await until(() => listEndpoints(root).some((e) => e.sessionId === "process-peer"))
		const sent = a.send(sessionIdSchema.parse("process-peer"), "hello")
		const replies: ReturnType<typeof a.receive> = []
		await until(() => {
			replies.push(...a.receive(() => {}))

			return replies.length > 0
		})
		peer.stdin.write("done")
		peer.stdin.end()
		expect(await peer.exited).toBe(0)
		expect(await new Response(peer.stderr).text()).toBe("")
		expect(replies.map((m) => [m.from.sessionId, m.text])).toEqual([["process-peer", `reply to ${sent.id}`]])
		expect(listEndpoints(root).map((e) => String(e.sessionId))).toEqual(["process-parent"])
	} finally {
		peer.kill()
		a.dispose()
	}
})

test("full inbox rejects and stale registration is not live", () => {
	const { root, a, b } = pair()

	for (let i = 0; i < MAX_INBOX; i++) a.send(sessionIdSchema.parse("b"), "bounded")
	expect(() => a.send(sessionIdSchema.parse("b"), "overflow")).toThrow("full")
	writeFileSync(
		join(root, b.endpoint.instanceId, "endpoint.json"),
		JSON.stringify({ ...b.endpoint, updatedAt: Date.now() - 20000 }),
	)
	expect(listEndpoints(root).map((e) => String(e.sessionId))).toEqual(["a"])
})

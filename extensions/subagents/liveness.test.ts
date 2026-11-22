import { afterEach, beforeEach, expect, test, vi } from "bun:test"
import { RexLiveness, type WatchRexEvents } from "./liveness"
import type { Exec } from "./rex"

let savedSession: string | undefined

let monitor: RexLiveness

let streams: { line: (line: string) => void; disconnect: () => void; stopped: boolean }[]

let queries: number

let alive: boolean

let failure: boolean

let changed: number

let duringQuery: (() => void) | undefined

const exec: Exec = async () => {
	queries++

	if (failure) throw new Error("Rex unavailable")
	const wasAlive = alive
	duringQuery?.()

	return { code: 0, stderr: "", stdout: JSON.stringify({ last_exit: wasAlive ? null : { exit_code: 0 } }) }
}

const watch: WatchRexEvents = (session, line, disconnect) => {
	expect(session).toBe("session:test")
	const stream = { line, disconnect, stopped: false }
	streams.push(stream)

	return () => {
		stream.stopped = true
	}
}

function event(type: string, name?: string, block = "block:child", session = "session:test") {
	return JSON.stringify({
		type: "session_event",
		payload: {
			session_id: session,
			event: { type, payload: { block_id: block, name } },
		},
	})
}

function connected() {
	streams.at(-1)!.line(event("block_event", "program_status_changed", "block:other"))
}

beforeEach(() => {
	vi.useFakeTimers()
	savedSession = process.env.REX_SESSION
	process.env.REX_SESSION = "session:test"
	queries = 0
	alive = true
	failure = false
	changed = 0
	duringQuery = undefined
	streams = []
	monitor = new RexLiveness(exec, watch)
	monitor.start(() => changed++)
})

afterEach(() => {
	monitor.stop()
	vi.useRealTimers()

	if (savedSession === undefined) Reflect.deleteProperty(process.env, "REX_SESSION")
	else process.env.REX_SESSION = savedSession
})

test("healthy event delivery replaces repeated process queries, with bounded reconciliation", async () => {
	connected()
	expect(await monitor.read("block:child")).toEqual({ exists: true, alive: true })

	for (let i = 0; i < 29; i++) {
		vi.advanceTimersByTime(1000)
		await monitor.read("block:child")
	}

	expect(queries).toBe(1)
	alive = false // Simulate a missed exit during subscription startup.
	vi.advanceTimersByTime(1000)
	expect(await monitor.read("block:child")).toEqual({ exists: true, alive: false })
	expect(queries).toBe(2)
})

test("child exit and block closure take effect immediately without another query", async () => {
	connected()
	await monitor.read("block:child")
	streams[0]!.line(event("block_event", "child_exited"))
	expect(await monitor.read("block:child")).toEqual({ exists: true, alive: false })
	streams[0]!.line(event("block_closed"))
	expect(await monitor.read("block:child")).toEqual({ exists: false, alive: false })
	expect(queries).toBe(1)
	expect(changed).toBe(2)
})

test("foreground changes invalidate liveness rather than infer a process exit", async () => {
	connected()
	await monitor.read("block:child")
	streams[0]!.line(event("block_event", "process_changed"))
	expect(await monitor.read("block:child")).toEqual({ exists: true, alive: true })
	expect(queries).toBe(2)
})

test("malformed, unrelated, and OSC lifecycle reports cannot change tracked liveness", async () => {
	connected()
	await monitor.read("block:child")

	for (const line of [
		"not json",
		"null",
		"{}",
		event("block_closed", undefined, "block:other"),
		event("block_closed", undefined, "block:child", "session:other"),
		event("block_event", "program_status_changed"),
	]) {
		streams[0]!.line(line)
	}

	expect(await monitor.read("block:child")).toEqual({ exists: true, alive: true })
	expect(changed).toBe(0)
	expect(queries).toBe(1)
})

test("an exit delivered during a process query wins over the query's stale result", async () => {
	connected()
	duringQuery = () => streams[0]!.line(event("block_closed"))
	expect(await monitor.read("block:child")).toEqual({ exists: false, alive: false })
	expect(queries).toBe(1)
})

test("a disconnect clears cached liveness, falls back to queries, and reconnects", async () => {
	connected()
	await monitor.read("block:child")
	streams[0]!.disconnect()
	expect(streams[0]!.stopped).toBe(true)
	failure = true
	await expect(monitor.read("block:child")).rejects.toThrow("Rex unavailable")
	failure = false
	alive = false
	expect(await monitor.read("block:child")).toEqual({ exists: true, alive: false })
	vi.advanceTimersByTime(1000)
	expect(streams).toHaveLength(2)
	connected()
	alive = true
	await monitor.read("block:child")
	streams[0]!.line(event("block_closed")) // Delayed data from the old subscriber.
	expect(await monitor.read("block:child")).toEqual({ exists: true, alive: true })
	expect(queries).toBe(4)
})

test("no events means fresh queries, not an indefinitely optimistic connection", async () => {
	await monitor.read("block:child")
	alive = false
	expect(await monitor.read("block:child")).toEqual({ exists: true, alive: false })
	expect(queries).toBe(2)
})

test("query failures are never cached as exits", async () => {
	connected()
	failure = true
	await expect(monitor.read("block:child")).rejects.toThrow("Rex unavailable")
	failure = false
	expect(await monitor.read("block:child")).toEqual({ exists: true, alive: true })
})

test("stopping cancels reconnects and restarting discards the previous session's cache", async () => {
	connected()
	await monitor.read("block:child")
	streams[0]!.disconnect()
	monitor.stop()
	vi.advanceTimersByTime(60_000)
	expect(streams).toHaveLength(1)
	monitor.start(() => changed++)
	connected()
	alive = false
	expect(await monitor.read("block:child")).toEqual({ exists: true, alive: false })
	monitor.stop()
	expect(streams[1]!.stopped).toBe(true)
	const count = changed
	streams[1]!.line(event("block_closed"))
	expect(changed).toBe(count)
})

test("a cached observation still honors cancellation", async () => {
	connected()
	await monitor.read("block:child")
	const controller = new AbortController()
	controller.abort()
	await expect(monitor.read("block:child", controller.signal)).rejects.toThrow()
})

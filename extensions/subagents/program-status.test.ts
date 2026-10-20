import { afterEach, expect, test } from "bun:test"
import type { ParentContext } from "./contracts"
import { ProgramStatusReporter, type RunStatus } from "./program-status"

const reporters: ProgramStatusReporter[] = []

function setup(
	options: { isTTY?: boolean; env?: NodeJS.ProcessEnv; mode?: ParentContext["mode"]; hasUI?: boolean } = {},
) {
	const writes: string[] = []

	const reporter = new ProgramStatusReporter({
		write: (data) => {
			writes.push(data)
		},
		isTTY: options.isTTY ?? true,
		env: options.env ?? {},
	})

	reporters.push(reporter)
	reporter.start({ mode: options.mode ?? "tui", hasUI: options.hasUI ?? true })

	return { reporter, writes }
}

function status(handle = "abc123", state: RunStatus["state"] = "busy"): RunStatus {
	return { run: { handle, name: "reviewer", createdAt: "2026-01-01" }, state }
}

function fields(report: string | undefined): Record<string, string> {
	expect(report).toStartWith("\x1b]7501;")
	expect(report).toEndWith("\x1b\\")

	return Object.fromEntries(
		(report ?? "")
			.slice(7, -2)
			.split(":")
			.map((pair) => {
				const at = pair.indexOf("=")

				return [pair.slice(0, at), pair.slice(at + 1)]
			}),
	)
}

function decoded(report: string | undefined, key: string): string {
	return Buffer.from(fields(report)[key] ?? "", "base64").toString("utf8")
}

afterEach(() => {
	for (const reporter of reporters) reporter.dispose()
	reporters.length = 0
})

test("namespaced reports separate title/activity, deduplicate, rename, and clear only owned ids", () => {
	const { reporter, writes } = setup()
	const child = status()
	reporter.sync([child])
	expect(fields(writes[0])).toMatchObject({ state: "working", id: "subagents/abc123", app: "pi-subagents" })
	expect(decoded(writes[0], "title")).toBe("reviewer")
	expect(decoded(writes[0], "msg")).toBe("Running")
	reporter.sync([child])
	expect(writes).toHaveLength(1)
	child.run.name = "renamed"
	reporter.sync([child])
	expect(decoded(writes[1], "title")).toBe("renamed")
	reporter.sync([])
	expect(fields(writes[2])).toEqual({ state: "clear", id: "subagents/abc123" })
	reporter.dispose()
	expect(writes).toHaveLength(3)
})

test.each([
	["starting", undefined, "working", "Starting"],
	["idle", undefined, "idle", "Idle"],
	["idle", "success", "done", "Finished"],
	["idle", "error", "error", "Failed"],
	["idle", "aborted", "idle", "Cancelled"],
	["error", "success", "error", "Failed"],
	["exited", "success", "error", "Exited"],
	["suspended", "success", "idle", "Suspended"],
	["unknown", "success", "idle", "Status unavailable"],
] as const)("maps %s / %s to %s (%s)", (state, outcome, expected, message) => {
	const { reporter, writes } = setup()
	const child = status("abc123", state)
	child.run.outcome = outcome
	reporter.sync([child])
	expect(fields(writes[0]).state).toBe(expected)
	expect(decoded(writes[0], "msg")).toBe(message)
})

test.each([
	{ mode: "rpc" },
	{ mode: "json" },
	{ mode: "print" },
	{ hasUI: false },
	{ isTTY: false },
	{ env: { TERM: "dumb" } },
	{ env: { PI_PROGRAM_STATUS: "0" } },
] as const)("does not write outside an enabled interactive terminal: %j", (options) => {
	const { reporter, writes } = setup(options)
	reporter.sync([status()])
	reporter.dispose()
	expect(writes).toEqual([])
})

test("bounds UTF-8 labels and removes C0, C1 and bidi controls", () => {
	const { reporter, writes } = setup()
	const child = status()
	child.run.name = "x\x1b\x07\n\t\x7f\u009b\u202e" + "😀".repeat(1000)
	reporter.sync([child])
	const title = decoded(writes[0], "title")
	expect(title).toStartWith("x       ")
	expect(title).not.toContain("\ufffd")
	expect(Buffer.byteLength(title)).toBeLessThanOrEqual(192)
	expect(fields(writes[0]).title?.length).toBeLessThanOrEqual(256)
	expect(Buffer.byteLength(writes[0] ?? "")).toBeLessThan(4096)
})

test("invalid handles cannot inject records or target the root; stopped runs disappear", () => {
	const { reporter, writes } = setup()
	reporter.sync([status()])
	reporter.sync([status("abc123", "stopped"), ...["", "x:y", "a/b", "a".repeat(33), "\x1b"].map((id) => status(id))])
	expect(writes).toHaveLength(2)
	expect(fields(writes[1])).toEqual({ state: "clear", id: "subagents/abc123" })
})

test("reserves space for Pi, prioritizes working runs, clears evicted ids before additions", () => {
	const { reporter, writes } = setup()

	const children = Array.from({ length: 70 }, (_, i) => {
		const child = status(i.toString(16), "idle")
		child.run.createdAt = String(i).padStart(3, "0")
		child.run.outcome = "success"

		return child
	})

	reporter.sync(children)
	expect(writes).toHaveLength(63)
	expect(writes.some((report) => fields(report).id === "subagents/0")).toBe(false)
	const active = status("0")
	active.run.createdAt = "000"
	reporter.sync([active, ...children.slice(1)])
	expect(writes).toHaveLength(65)
	expect(fields(writes[63])).toEqual({ state: "clear", id: "subagents/7" })
	expect(fields(writes[64])).toMatchObject({ state: "working", id: "subagents/0" })
})

test("session replacement clears records; dispose is idempotent and prevents later writes", () => {
	const { reporter, writes } = setup()
	reporter.sync([status()])
	reporter.start({ mode: "rpc", hasUI: true })
	expect(fields(writes[1])).toEqual({ state: "clear", id: "subagents/abc123" })
	reporter.sync([status()])
	reporter.dispose()
	reporter.dispose()
	expect(writes).toHaveLength(2)
})

test.skipIf(process.platform === "win32")("SIGCONT restores unchanged records and the listener is released", () => {
	const before = process.listenerCount("SIGCONT")
	const { reporter, writes } = setup()
	expect(process.listenerCount("SIGCONT")).toBe(before + 1)
	reporter.sync([status()])
	process.emit("SIGCONT")
	expect(writes).toEqual([writes[0], writes[0]])
	reporter.dispose()
	expect(process.listenerCount("SIGCONT")).toBe(before)
	process.emit("SIGCONT")
	expect(writes).toHaveLength(3)
})

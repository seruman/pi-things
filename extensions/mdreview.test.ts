import { afterEach, describe, expect, mock, test } from "bun:test"
import { readFile, rm, stat, writeFile } from "node:fs/promises"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent"
import {
	type Host,
	type Session,
	feedbackMessage,
	lastAssistantText,
	newLayerRequest,
	open,
	prepare,
	reviewCommand,
	rexFromEnv,
} from "./mdreview.ts"

const directories: string[] = []

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function message(id: string, message: SessionMessageEntry["message"]): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-11-17T00:00:00.000Z", message }
}

function assistant(text: string): SessionEntry {
	// SAFETY: lastAssistantText reads only the role and content of an assistant message.
	return message(text, { role: "assistant", content: [{ type: "text", text }] } as AssistantMessage)
}

function user(text: string): SessionEntry {
	return message(text, { role: "user", content: text, timestamp: 0 })
}

describe("Rex", () => {
	test.each([undefined, "session:stale", " "])("resolves the pane's session (REX_SESSION: %s)", async (legacy) => {
		const { exec, calls } = fakeRex(async () => {})
		expect(await rexFromEnv({ TERM_PROGRAM: "rex", REX_SESSION: legacy, REX_BLOCK: "block:b" }, { exec })).toEqual({
			session: "session:a",
			block: "block:b",
		})
		expect(calls).toEqual([["rex", "block", "inspect", "block:b", "--json"]])
	})

	test("needs a Rex terminal and a block, without querying the focused session", async () => {
		const { exec } = fakeRex(async () => {})
		expect(await rexFromEnv({ TERM_PROGRAM: "ghostty", REX_BLOCK: "block:b" }, { exec })).toBeUndefined()
		expect(await rexFromEnv({ TERM_PROGRAM: "rex", REX_BLOCK: " " }, { exec })).toBeUndefined()
		expect(await rexFromEnv({ TERM_PROGRAM: "rex", REX_SESSION: "session:a" }, { exec })).toBeUndefined()
		expect(exec).not.toHaveBeenCalled()
	})

	test("asks for a floating terminal layer in the caller's window", () => {
		const request = JSON.parse(newLayerRequest({ session: "session:a", block: "block:b" }, "window:w", "/p", ["x"]))
		expect(request).toEqual({
			session_id: "session:a",
			bounds: [0.2, 0.06, 0.6, 0.88],
			focus: true,
			window_id: "window:w",
			layout: {
				block: { flavor: "com.superlogical.terminal.shell", label: "mdreview", options: { command: ["x"], cwd: "/p" } },
			},
		})
		expect(
			JSON.parse(newLayerRequest({ session: "session:a", block: "block:b" }, undefined, "/p", ["x"])),
		).not.toHaveProperty("window_id")
	})
})

describe("what gets reviewed", () => {
	test("the last message is the newest assistant text, skipping turns without any", () => {
		expect(lastAssistantText([assistant("first"), user("q"), assistant("second"), user("again")])).toBe("second")
		expect(lastAssistantText([user("q")])).toBeUndefined()
	})

	test("a file opens by path; the last message goes in on stdin", async () => {
		const file = await prepare("/docs/plan.md", "`plan.md`")
		directories.push(file.directory)
		expect(reviewCommand("/bin/mdreview", file)).toEqual([
			"/usr/bin/env",
			"RUNE_TERMINAL=1",
			"/bin/mdreview",
			"/docs/plan.md",
			"-o",
			file.output,
		])

		const last = await prepare(undefined, "your last message", "# Hi\n")
		directories.push(last.directory)
		expect(await readFile(last.document, "utf8")).toBe("# Hi\n")
		expect((await stat(last.document)).mode & 0o777).toBe(0o600)
		expect(reviewCommand("/bin/mdreview", last)).toEqual([
			"/bin/sh",
			"-c",
			'RUNE_TERMINAL=1 exec "$0" - -o "$1" < "$2"',
			"/bin/mdreview",
			last.output,
			last.document,
		])
	})

	test("the message says what was reviewed", () => {
		expect(feedbackMessage("`plan.md`", "\n# Review\n\nok\n\n")).toBe(
			"I reviewed `plan.md` in mdreview. My feedback:\n\n# Review\n\nok\n",
		)
	})
})

function fakeRex(onWait: () => Promise<void>, waited = 0) {
	const calls: string[][] = []
	const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", killed: false, truncated: false })
	const windows = { windows: [{ window_id: "window:w", layers: [{ blocks: [{ block_id: "block:b" }] }] }] }

	const exec = mock(async (command: string, args: string[]) => {
		calls.push([command, ...args])

		if (args[0] === "block" && args[1] === "inspect") {
			return ok(JSON.stringify({ session_id: "session:a", block: { block_id: "block:b" } }))
		}

		if (args[0] === "session") return ok(JSON.stringify(windows))

		if (args[0] === "wait") {
			await onWait()

			return { ...ok(""), code: waited }
		}

		if (args.includes("session.new_layer")) return ok(JSON.stringify({ layer_id: "layer:l", block_ids: ["block:m"] }))

		return ok("{}")
	})

	return { calls, exec }
}

function session(idle: boolean) {
	const notes: string[] = []

	const ctx: Session = {
		cwd: "/p",
		hasUI: true,
		isIdle: () => idle,
		ui: { notify: (message: string) => notes.push(message) },
	}

	return { ctx, notes }
}

describe("a review", () => {
	const previous = process.env.MDREVIEW_BIN

	afterEach(() => {
		if (previous === undefined) Reflect.deleteProperty(process.env, "MDREVIEW_BIN")
		else process.env.MDREVIEW_BIN = previous
	})

	test("sends what mdreview wrote, then closes the layer and cleans up", async () => {
		Reflect.deleteProperty(process.env, "MDREVIEW_BIN")
		const review = await prepare(undefined, "your last message", "text")
		const { calls, exec } = fakeRex(() => writeFile(review.output, "# Review\n\nfix it\n"))
		const sent: [string, unknown][] = []
		const pi: Host = { exec, sendUserMessage: (message, options) => void sent.push([String(message), options]) }
		const { ctx } = session(false)

		const rex = await rexFromEnv({ TERM_PROGRAM: "rex", REX_BLOCK: "block:b" }, pi)
		expect(rex).toBeDefined()
		const { done } = await open(pi, ctx, rex!, review)
		await done

		expect(sent).toEqual([
			["I reviewed your last message in mdreview. My feedback:\n\n# Review\n\nfix it\n", { deliverAs: "followUp" }],
		])
		const methods = calls.filter((c) => c[1] === "api").map((c) => c[5])
		expect(methods).toEqual(["session.new_layer", "session.close_layer", "session.focus_block"])

		for (const call of calls.filter((c) => c[1] === "api")) {
			expect(call[4]).toBe("session:a")
			expect(JSON.parse(call[6]).session_id).toBe("session:a")
		}

		expect(calls.find((c) => c[1] === "wait")).toEqual(["rex", "wait", "-s", "session:a", "block:m"])

		expect(JSON.parse(calls.find((c) => c[5] === "session.new_layer")![6]).layout.block.options.command[3]).toBe(
			"mdreview",
		)
		expect(JSON.parse(calls.find((c) => c[5] === "session.new_layer")![6]).window_id).toBe("window:w")
		expect(await stat(review.directory).catch(() => undefined)).toBeUndefined()
	})

	test("sends nothing when mdreview wrote nothing", async () => {
		process.env.MDREVIEW_BIN = "/custom/mdreview"
		const review = await prepare("/docs/plan.md", "`plan.md`")
		const { calls, exec } = fakeRex(async () => {})
		const sent: string[] = []
		const pi: Host = { exec, sendUserMessage: (message) => void sent.push(String(message)) }
		const { ctx, notes } = session(true)

		await (
			await open(pi, ctx, { session: "session:a", block: "block:b" }, review)
		).done

		expect(sent).toEqual([])
		expect(notes).toEqual(["Review closed, nothing sent"])
		expect(JSON.parse(calls.find((c) => c[5] === "session.new_layer")![6]).layout.block.options.command[2]).toBe(
			"/custom/mdreview",
		)
		expect(calls.map((c) => c[0])).not.toContain("/bin/sh")
	})

	test("says when the layer couldn't find mdreview", async () => {
		Reflect.deleteProperty(process.env, "MDREVIEW_BIN")
		const review = await prepare("/docs/plan.md", "`plan.md`")
		const { exec } = fakeRex(async () => {}, 127)
		const pi: Host = { exec, sendUserMessage: () => {} }
		const { ctx, notes } = session(true)

		await (
			await open(pi, ctx, { session: "session:a", block: "block:b" }, review)
		).done

		expect(notes).toEqual(["mdreview wasn't found in the layer's PATH; set MDREVIEW_BIN"])
	})
})

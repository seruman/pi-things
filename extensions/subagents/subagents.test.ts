import { afterEach, beforeEach, expect, test, vi } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import type { StopReason } from "@earendil-works/pi-ai"
import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent"
import { installBridge } from "./bridge"
import installParent from "./index"
import { type Exec, readProcess } from "./rex"
import {
	type RunMetadata,
	getRun,
	inboxDir,
	listRuns,
	readMetadata,
	runDirectory,
	updateMetadata,
	writeMetadata,
} from "./runs"

type Handler = (event: { reason?: string }, ctx: ExtensionContext) => unknown
function events() {
	const handlers = new Map<string, Handler>()
	return {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		emit: async (event: string, ctx: ExtensionContext, reason?: string) => {
			await handlers.get(event)?.({ reason }, ctx)
		},
	}
}

type Tool = {
	name: string
	execute: (
		id: string,
		params: never,
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: ExtensionContext,
	) => Promise<{ structuredContent: Record<string, unknown> }>
}
type Block = { exit: number | null; error?: string }
let root: string
let savedEnv: Record<string, string | undefined>
let ctx: ExtensionContext
let parent: ReturnType<typeof events>
let tools: Map<string, Tool>
let blocks: Map<string, Block>
let launches: { options: { cwd: string; command: string[] }; label: string }[]
let failLaunch: boolean
let failClose: boolean
let onProcess: (() => void) | undefined
let widgets: (string[] | undefined)[]
const envKeys = ["PI_CODING_AGENT_DIR", "PI_SUBAGENT_RUN_DIR", "REX_SESSION", "REX_BLOCK"]

// Only the external Rex transport is faked. Unexpected operations fail, rather than silently succeeding.
const exec: Exec = async (command, args, signal) => {
	signal?.throwIfAborted()
	expect(command).toBe("rex")
	if (args[0] === "block" && args[4] === "process") {
		onProcess?.()
		const block = blocks.get(args[3] ?? "")
		if (!block) return { code: 1, stdout: "", stderr: `Error: block target "${args[3]}" not found` }
		if (block.error) throw new Error(block.error)
		return {
			code: 0,
			stderr: "",
			stdout: JSON.stringify({
				last_exit: block.exit === null ? null : { exit_code: block.exit },
				child: { name: "rebranded-pi" },
			}),
		}
	}
	const payload = JSON.parse(args[5] ?? "{}")
	if (args[4] === "session.new_block") {
		if (failLaunch) throw new Error("launch failed")
		launches.push(payload)
		const blockId = `block:${launches.length}`
		blocks.set(blockId, { exit: null })
		return { code: 0, stderr: "", stdout: JSON.stringify({ block_id: blockId }) }
	}
	if (args[4] === "block.close") {
		if (failClose) throw new Error("close failed")
		blocks.delete(payload.block_id)
		return { code: 0, stderr: "", stdout: "{}" }
	}
	throw new Error(`Unexpected Rex operation: ${args.join(" ")}`)
}

beforeEach(() => {
	savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
	root = mkdtempSync(join(tmpdir(), "subagents-test-"))
	process.env.PI_CODING_AGENT_DIR = root
	process.env.REX_SESSION = "session:parent"
	Reflect.deleteProperty(process.env, "PI_SUBAGENT_RUN_DIR")
	vi.useFakeTimers()
	tools = new Map()
	blocks = new Map()
	launches = []
	widgets = []
	failLaunch = failClose = false
	onProcess = undefined
	parent = events()
	ctx = {
		cwd: root,
		hasUI: false,
		model: { provider: "configured", id: "parent" },
		sessionManager: { getSessionId: () => "parent" },
		ui: {
			setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
			theme: { fg: (_color: string, text: string) => text },
			notify() {},
		},
	} as unknown as ExtensionContext
	installParent({
		on: parent.on,
		exec: (command: string, args: string[], options?: { signal?: AbortSignal }) => exec(command, args, options?.signal),
		getThinkingLevel: () => "off",
		registerCommand() {},
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
	} as unknown as ExtensionAPI)
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.clearAllTimers()
	vi.useRealTimers()
	rmSync(root, { recursive: true, force: true })
	for (const key of envKeys) {
		if (savedEnv[key] === undefined) Reflect.deleteProperty(process.env, key)
		else process.env[key] = savedEnv[key]
	}
})

async function call(name: string, params = {}, signal?: AbortSignal) {
	const tool = tools.get(name)
	if (!tool) throw new Error(`Missing tool: ${name}`)
	return (await tool.execute("test", params as never, signal, undefined, ctx)).structuredContent
}
async function spawn(params = {}) {
	const result = await call("agent_spawn", { prompt: "task", background: true, ...params })
	return getRun(String(result.handle))
}
async function tick(ms = 0) {
	vi.advanceTimersByTime(ms)
	await setImmediate() // Drain asynchronous Rex calls without guessing how many microtasks they need.
}

// Real bridge, metadata and transcripts; only Pi's event source and message sink are supplied here.
async function child(run: RunMetadata, start = true) {
	const hooks = events()
	const c = {
		idle: true,
		session: SessionManager.open(run.sessionFile, undefined, root),
		names: [] as string[],
		sent: [] as { message: string; deliverAs?: string }[],
		emit: (event: string, reason?: string) =>
			hooks.emit(
				event,
				{
					isIdle: () => c.idle,
					sessionManager: c.session,
				} as unknown as ExtensionContext,
				reason,
			),
		begin: async () => {
			c.idle = false
			await c.emit("agent_start")
		},
		reply: async (text: string, stopReason: StopReason = "stop") => {
			c.session.appendMessage({ role: "user", content: "task", timestamp: Date.now() })
			c.session.appendMessage({
				role: "assistant",
				content: [{ type: "text", text }],
				stopReason,
				api: "openai-responses",
				provider: run.provider,
				model: run.model,
				timestamp: Date.now(),
				...(stopReason === "error" ? { errorMessage: text } : {}),
				usage: {
					input: 2,
					output: 3,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 5,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			})
			c.idle = true
			await c.emit("agent_settled")
		},
	}
	installBridge(
		{
			on: hooks.on,
			setSessionName: (name: string) => c.names.push(name),
			sendUserMessage: (message: string, options?: { deliverAs?: string }) => c.sent.push({ message, ...options }),
		} as unknown as ExtensionAPI,
		runDirectory(run.handle),
	)
	if (start) await c.emit("session_start")
	return c
}

test("launch uses the current extension, shell defaults and explicit tool flags; [] keeps defaults", async () => {
	const run = await spawn({ tools: [] })
	expect(launches[0]).toMatchObject({ label: `subagent ${run.handle}`, options: { cwd: root } })
	expect(launches[0]?.options).not.toHaveProperty("shell")
	const command = launches[0]?.options.command ?? []
	expect(command.slice(command.indexOf("--extension"), command.indexOf("--extension") + 2)).toEqual([
		"--extension",
		new URL("./index.ts", import.meta.url).pathname,
	])
	expect(command).not.toContain("--tools")
	expect(command).not.toContain("--no-tools")
	for (const noTools of ["all", "builtin"]) {
		const restricted = await spawn({ tools: "readonly", noTools })
		expect(restricted.launchArgs).toEqual([
			"--tools",
			"read,grep,find,ls",
			"--exclude-tools",
			"codemode,agent_spawn,agent_send,agent_wait,agent_stop,agent_list,agent_rename",
			noTools === "all" ? "--no-tools" : "--no-builtin-tools",
		])
	}
})

test.each(["stop", "error", "aborted"] as const)(
	"wait returns the bridge's settled reply (%s), including for rebranded Pi",
	async (reason) => {
		const run = await spawn()
		const c = await child(run)
		await c.begin()
		await c.reply("ANSWER", reason)
		expect(await call("agent_wait", { handle: run.handle })).toMatchObject({
			answer: "ANSWER",
			status: reason === "stop" ? "success" : reason,
			usage: { totalTokens: 5 },
		})
	},
)

test("synchronous spawn waits for the bridge to finish the initial task", async () => {
	const spawning = call("agent_spawn", { prompt: "task" })
	await tick()
	const run = listRuns()[0]
	if (!run) throw new Error("Missing spawned run")
	const c = await child(run)
	await c.begin()
	await c.reply("DONE")
	await tick(500)
	expect(await spawning).toMatchObject({ status: "success", answer: "DONE" })
})

test("send then wait retries a failed turn instead of returning its old error", async () => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("OLD FAILURE", "error")
	await call("agent_send", { handle: run.handle, message: "retry" })
	let finished = false
	const waiting = call("agent_wait", { handle: run.handle, timeoutSec: 2 }).then((result) => {
		finished = true
		return result
	})
	await tick()
	expect(finished).toBe(false)
	await tick(250)
	expect(c.sent).toEqual([{ message: "retry" }])
	await c.begin()
	await c.reply("RECOVERED")
	await tick(500)
	expect(await waiting).toMatchObject({ status: "success", answer: "RECOVERED" })
})

test("startup and busy polling do not read transcripts, and a timeout leaves the child alive", async () => {
	const run = await spawn()
	const c = await child(run)
	const opened = vi.spyOn(SessionManager, "open")
	const waiting = call("agent_wait", { handle: run.handle, timeoutSec: 1 })
	await tick()
	expect(opened).not.toHaveBeenCalled()
	await c.begin()
	await tick(500)
	expect(opened).not.toHaveBeenCalled()
	await tick(500)
	expect(await waiting).toMatchObject({ status: "error", error: "timeout after 1s" })
	expect(blocks.has(run.blockId)).toBe(true)
	await expect(call("agent_wait", { handle: run.handle, timeoutSec: 0 })).rejects.toThrow("positive integer")
})

test("completion reads metadata and the transcript after asynchronous process inspection", async () => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	onProcess = () => {
		onProcess = undefined
		void c.reply("JUST FINISHED")
	}
	expect(await call("agent_wait", { handle: run.handle })).toMatchObject({ answer: "JUST FINISHED" })
})

test("cancellation closes the block but preserves the transcript", async () => {
	const run = await spawn()
	const controller = new AbortController()
	const waiting = call("agent_wait", { handle: run.handle }, controller.signal)
	await tick()
	controller.abort()
	await tick(500)
	expect(await waiting).toMatchObject({ status: "aborted" })
	expect(blocks.has(run.blockId)).toBe(false)
	expect(existsSync(run.sessionFile)).toBe(true)
})

test("bridge initializes late metadata, syncs names and follows session changes", async () => {
	const run = await spawn({ name: "review" })
	rmSync(join(runDirectory(run.handle), "metadata.json"))
	const c = await child(run)
	await c.begin()
	writeMetadata(run)
	await tick(250)
	expect(getRun(run.handle)).toMatchObject({ hasStarted: true, state: "busy" })
	expect(c.names).toEqual(["subagent review"])
	await call("agent_rename", { handle: run.handle, name: " renamed " })
	await tick(500)
	expect(c.names).toEqual(["subagent review", "subagent renamed"])
	await c.emit("session_shutdown", "switch")
	c.session = SessionManager.create(root, root)
	await c.emit("session_start")
	await c.begin()
	await c.reply("NEW SESSION")
	expect(c.session.getSessionFile()).toBe(getRun(run.handle).sessionFile)
	expect(await call("agent_wait", { handle: run.handle })).toMatchObject({ answer: "NEW SESSION", name: "renamed" })
	await c.emit("session_shutdown", "quit")
	expect(getRun(run.handle).state).toBe("exited")
})

test("inbox removes malformed messages, prompts idle children, and steers or queues while busy", async () => {
	const run = await spawn()
	const c = await child(run)
	const inbox = inboxDir(runDirectory(run.handle))
	writeFileSync(join(inbox, "bad.json"), "{")
	await tick(250)
	expect(readdirSync(inbox)).toEqual([])
	expect(await call("agent_wait", { handle: run.handle })).toMatchObject({ status: "error" })
	await call("agent_send", { handle: run.handle, message: "prompt" })
	await tick(250)
	await c.begin()
	await call("agent_send", { handle: run.handle, message: "steer" })
	await tick(250)
	await call("agent_send", { handle: run.handle, message: "later", followUp: true })
	await tick(250)
	expect(c.sent).toEqual([
		{ message: "prompt" },
		{ message: "steer", deliverAs: "steer" },
		{ message: "later", deliverAs: "followUp" },
	])
	expect(getRun(run.handle).error).toBeUndefined()
})

test("suspend/resume preserves the session and flags; failed close cannot duplicate a live child", async () => {
	const run = await spawn({ name: "worker", tools: "readonly" })
	failClose = true
	await expect(parent.emit("session_shutdown", ctx)).rejects.toThrow("subagent suspend failed")
	failClose = false
	await parent.emit("session_start", ctx)
	expect(launches).toHaveLength(1)
	await parent.emit("session_shutdown", ctx)
	failLaunch = true
	await parent.emit("session_start", ctx)
	expect(getRun(run.handle)).toMatchObject({ state: "error", error: "launch failed", suspended: true })
	failLaunch = false
	await parent.emit("session_start", ctx)
	expect(launches).toHaveLength(2)
	expect(launches[1]?.options.command).toEqual(launches[0]?.options.command.slice(0, -1))
	expect(getRun(run.handle)).toMatchObject({ name: "worker", sessionFile: run.sessionFile, suspended: false })
})

test("stop and parent shutdown remove exited blocks too", async () => {
	for (const action of ["stop", "shutdown"]) {
		const run = await spawn()
		blocks.set(run.blockId, { exit: 0 })
		if (action === "stop") await call("agent_stop", { handle: run.handle })
		else await parent.emit("session_shutdown", ctx)
		expect(blocks.has(run.blockId)).toBe(false)
		expect(existsSync(runDirectory(run.handle))).toBe(false)
	}
})

test("missing blocks mean exited, but connection failures stay unknown and don't hide healthy children", async () => {
	const failed = await spawn()
	const healthy = await spawn({ name: "healthy" })
	const c = await child(healthy)
	await c.begin()
	blocks.set(failed.blockId, { exit: null, error: "connection refused" })
	const result = await call("agent_list")
	expect(result.runs).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ handle: failed.handle, state: "unknown", error: "connection refused" }),
			expect.objectContaining({ handle: healthy.handle, state: "busy" }),
		]),
	)
	ctx.hasUI = true
	await parent.emit("session_start", ctx)
	expect(widgets.at(-1)?.join()).toContain("healthy:busy")
	blocks.delete(failed.blockId)
	expect(await readProcess(exec, failed.blockId)).toMatchObject({ exists: false, alive: false })
	await expect(call("agent_send", { handle: failed.handle, message: "no" })).rejects.toThrow("not running")
	await parent.emit("session_shutdown", ctx, "reload")
	await tick(1000)
	expect(widgets.at(-1)).toBeUndefined()
})

test("metadata skips corrupt records, list stays parent-scoped, and names/handles are validated", async () => {
	const run = await spawn()
	const other = await spawn()
	updateMetadata(runDirectory(other.handle), { parentSessionId: "other" })
	expect((await call("agent_list")).runs).toEqual([expect.objectContaining({ handle: run.handle })])
	writeFileSync(join(runDirectory(other.handle), "metadata.json"), "{")
	expect(readMetadata(runDirectory(other.handle))).toBeUndefined()
	expect(listRuns()).toHaveLength(1)
	await expect(call("agent_rename", { handle: run.handle, name: "bad\nname" })).rejects.toThrow()
	await expect(call("agent_stop", { handle: "../escape" })).rejects.toThrow("Invalid subagent handle")
})

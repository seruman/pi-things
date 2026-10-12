import { afterEach, beforeEach, expect, test, vi } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import {
	type AssistantMessage,
	type JsonObject,
	type JsonValue,
	type Static,
	type StopReason,
	Type,
} from "@earendil-works/pi-ai"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { Check } from "typebox/value"
import { type BridgeContext, type LifecycleEvent, installBridge } from "./bridge"
import { type ParentContext, installParent } from "./index"
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

function events<TContext>() {
	const handlers = new Map<string, (event: LifecycleEvent, ctx: TContext) => void | Promise<void>>()

	return {
		on: (event: string, handler: (event: LifecycleEvent, ctx: TContext) => void | Promise<void>) => {
			handlers.set(event, handler)
		},
		emit: async (event: string, ctx: TContext, reason?: string) => {
			await handlers.get(event)?.({ type: event, reason }, ctx)
		},
	}
}

type ToolCall = (params: JsonObject, signal?: AbortSignal) => Promise<JsonValue | undefined>

type Block = { exit: number | null; error?: string }

let root: string

let savedEnv: Record<string, string | undefined>

let ctx: ParentContext

let parent: ReturnType<typeof events<ParentContext>>

let tools: Map<string, ToolCall>

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
	parent = events<ParentContext>()
	ctx = {
		cwd: root,
		hasUI: false,
		model: { provider: "configured", id: "parent" },
		sessionManager: { getSessionId: () => "parent" },
		ui: {
			setWidget: (_key, lines) => {
				widgets.push(lines)
			},
			theme: { fg: (_color, text) => text },
			notify() {},
			custom() {
				throw new Error("Unexpected custom UI")
			},
		},
	}
	installParent({
		on: parent.on,
		exec: async (command, args, options) => ({ ...(await exec(command, args, options?.signal)), killed: false }),
		getThinkingLevel: () => "off",
		registerCommand() {},
		registerTool: (tool) => {
			tools.set(tool.name, async (params, signal) => {
				if (!Check(tool.parameters, params)) throw new Error(`Invalid parameters for ${tool.name}`)
				// SAFETY: Check validated the registered plain-JSON schema. Local TypeBox 1.3.7 and
				// the SDK's 1.3.27 disagree on generic Static types, not these JSON parameter types.
				const validated = params as Static<typeof tool.parameters>
				const result = await tool.execute("test", validated, signal, undefined, ctx)
				expect(result.structuredContent).toEqual(result.details)

				return result.structuredContent
			})
		},
	})
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

async function call(name: string, params: JsonObject = {}, signal?: AbortSignal) {
	const tool = tools.get(name)

	if (!tool) throw new Error(`Missing tool: ${name}`)

	return tool(params, signal)
}

async function spawn(params: JsonObject = {}) {
	const result = await call("agent_spawn", { prompt: "task", background: true, ...params })

	if (!Check(Type.Object({ handle: Type.String() }), result)) throw new Error("Spawn returned no handle")

	return getRun(result.handle)
}

async function tick(ms = 0) {
	vi.advanceTimersByTime(ms)
	await setImmediate() // Drain asynchronous Rex calls without guessing how many microtasks they need.
}

// Real bridge, metadata and transcripts; only Pi's event source and message sink are supplied here.
async function child(run: RunMetadata, start = true) {
	const hooks = events<BridgeContext>()
	const names: string[] = []
	const sent: { message: string; deliverAs?: "steer" | "followUp" }[] = []

	const c = {
		idle: true,
		session: SessionManager.open(run.sessionFile, undefined, root),
		names,
		sent,
		emit: (event: string, reason?: string) =>
			hooks.emit(
				event,
				{
					isIdle: () => c.idle,
					sessionManager: c.session,
				},
				reason,
			),
		begin: async () => {
			c.idle = false
			await c.emit("agent_start")
		},
		reply: async (text: string, stopReason: StopReason = "stop") => {
			c.session.appendMessage({ role: "user", content: "task", timestamp: Date.now() })

			const reply: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text }],
				stopReason,
				api: "openai-responses",
				provider: run.provider,
				model: run.model,
				timestamp: Date.now(),
				usage: {
					input: 2,
					output: 3,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 5,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}

			if (stopReason === "error") reply.errorMessage = text
			c.session.appendMessage(reply)
			c.idle = true
			await c.emit("agent_settled")
		},
	}

	installBridge(
		{
			on: hooks.on,
			setSessionName: (name) => {
				c.names.push(name)
			},
			sendUserMessage: (message, options) => {
				c.sent.push({ message, ...options })
			},
		},
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

test.each(["polling", "process inspection"])("cancelling wait during %s leaves the child usable", async (phase) => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	const controller = new AbortController()
	if (phase === "process inspection") {
		onProcess = () => {
			onProcess = undefined
			controller.abort()
			controller.signal.throwIfAborted()
		}
	}
	const waiting = call("agent_wait", { handle: run.handle }, controller.signal)
	await tick()
	if (phase === "polling") {
		controller.abort()
		await tick(500)
	}
	expect(await waiting).toMatchObject({ status: "aborted" })
	expect(blocks.has(run.blockId)).toBe(true)
	expect(getRun(run.handle).state).toBe("busy")
	expect(existsSync(run.sessionFile)).toBe(true)
	await call("agent_send", { handle: run.handle, message: "continue the task" })
	await tick(250)
	expect(c.sent).toEqual([{ message: "continue the task", deliverAs: "steer" }])
	await c.reply("DONE")
	expect(await call("agent_wait", { handle: run.handle })).toMatchObject({ status: "success", answer: "DONE" })
	await call("agent_stop", { handle: run.handle })
	expect(blocks.has(run.blockId)).toBe(false)
})

test("cancelling foreground spawn still closes the block and preserves the transcript", async () => {
	const controller = new AbortController()
	const spawning = call("agent_spawn", { prompt: "task" }, controller.signal)
	await tick()
	const run = listRuns()[0]
	if (!run) throw new Error("Missing spawned run")
	controller.abort()
	await tick(500)
	expect(await spawning).toMatchObject({ status: "aborted" })
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
	expect(result).toEqual({
		runs: expect.arrayContaining([
			expect.objectContaining({ handle: failed.handle, state: "unknown", error: "connection refused" }),
			expect.objectContaining({ handle: healthy.handle, state: "busy" }),
		]),
	})
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
	expect(await call("agent_list")).toEqual({ runs: [expect.objectContaining({ handle: run.handle })] })
	writeFileSync(join(runDirectory(other.handle), "metadata.json"), "{")
	expect(readMetadata(runDirectory(other.handle))).toBeUndefined()
	expect(listRuns()).toHaveLength(1)
	await expect(call("agent_rename", { handle: run.handle, name: "bad\nname" })).rejects.toThrow()
	await expect(call("agent_stop", { handle: "../escape" })).rejects.toThrow("Invalid subagent handle")
})

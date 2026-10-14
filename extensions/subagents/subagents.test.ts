import { afterEach, beforeEach, expect, test, vi } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import type { AssistantMessage, JsonObject, JsonValue, Static, StopReason } from "@earendil-works/pi-ai"
import { type AgentToolResult, type EventBus, SessionManager, createEventBus } from "@earendil-works/pi-coding-agent"
import { Check } from "typebox/value"
import { z } from "zod"
import { registerChildPolicy } from "../shell-leash/child-policy"
import { policyFlags, shellLeashHost } from "../shell-leash/test-host"
import { installBridge } from "./bridge"
import type { BridgeContext, LifecycleEvents, LifecycleHandler, ParentContext } from "./contracts"
import { installParent } from "./index"
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

type LifecycleListeners<Context> = {
	[Key in keyof LifecycleEvents]: Set<LifecycleHandler<LifecycleEvents[Key], Context>>
}

function events<Context>() {
	const handlers: LifecycleListeners<Context> = {
		session_start: new Set(),
		session_shutdown: new Set(),
		agent_start: new Set(),
		agent_settled: new Set(),
	}

	async function dispatch<Key extends keyof LifecycleEvents>(type: Key, event: LifecycleEvents[Key], ctx: Context) {
		for (const handler of handlers[type]) await handler(event, ctx)
	}

	return {
		on<Key extends keyof LifecycleEvents>(event: Key, handler: LifecycleHandler<LifecycleEvents[Key], Context>) {
			handlers[event].add(handler)

			return () => {
				handlers[event].delete(handler)
			}
		},
		emit(event: keyof LifecycleEvents, ctx: Context, reason: LifecycleEvents["session_shutdown"]["reason"] = "quit") {
			if (event === "session_shutdown") return dispatch(event, { type: event, reason }, ctx)

			return dispatch(event, { type: event }, ctx)
		},
	}
}

type Tool = (params: JsonObject, signal?: AbortSignal) => Promise<AgentToolResult<JsonValue>>

type Block = { exit: number | null; error?: string; closeError?: string }

const jsonSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(jsonSchema), z.record(jsonSchema)]),
)

const resultSchema = z.record(jsonSchema)

const launchRequestSchema = z
	.object({
		session_id: z.string(),
		flavor: z.literal("com.superlogical.terminal.shell"),
		label: z.string(),
		options: z.object({ cwd: z.string(), command: z.array(z.string()) }).strict(),
	})
	.strict()

const closeRequestSchema = z.object({ session_id: z.string(), block_id: z.string() }).strict()

let root: string

let savedEnv: Record<string, string | undefined>

let ctx: ParentContext

let parent: ReturnType<typeof events<ParentContext>>

let bus: EventBus

let tools: Map<string, Tool>

let blocks: Map<string, Block>

let nextBlockId: number

let launches: { cwd: string; command: string[] }[]

let onProcess: (() => void) | undefined

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
				child: { name: "rebranded-pi", pid: 1, user_id: 1 },
			}),
		}
	}

	if (args[4] === "session.new_block") {
		const payload = launchRequestSchema.parse(JSON.parse(args[5] ?? "{}"))
		launches.push(payload.options)
		const blockId = `block:${++nextBlockId}`
		blocks.set(blockId, { exit: null })

		return { code: 0, stderr: "", stdout: JSON.stringify({ block_id: blockId, revision: nextBlockId }) }
	}

	if (args[4] === "block.close") {
		const payload = closeRequestSchema.parse(JSON.parse(args[5] ?? "{}"))
		const error = blocks.get(payload.block_id)?.closeError

		if (error) throw new Error(error)
		blocks.delete(payload.block_id)

		return { code: 0, stderr: "", stdout: JSON.stringify({ block_id: payload.block_id, revision: nextBlockId }) }
	}

	throw new Error(`Unexpected Rex operation: ${args.join(" ")}`)
}

function unexpectedUI(): never {
	throw new Error("Unexpected UI call in a headless test")
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
	nextBlockId = 0
	launches = []
	onProcess = undefined
	parent = events<ParentContext>()
	bus = createEventBus()
	ctx = {
		cwd: root,
		hasUI: false,
		model: { provider: "configured", id: "parent" },
		sessionManager: { getSessionId: () => "parent" },
		ui: { theme: { fg: unexpectedUI }, setWidget: unexpectedUI, notify: unexpectedUI, custom: unexpectedUI },
	}
	installParent({
		events: bus,
		on: parent.on,
		exec: async (command, args, options) => ({ ...(await exec(command, args, options?.signal)), killed: false }),
		getThinkingLevel: () => "off",
		registerCommand() {},
		registerTool(tool) {
			// Pi and this repo resolve different TypeBox versions; validate using the declared wire schema.
			const parameters = z.custom<Static<typeof tool.parameters>>(
				(value) => Check(tool.parameters, value),
				`Invalid parameters for ${tool.name}`,
			)

			tools.set(tool.name, (params, signal) => tool.execute("test", parameters.parse(params), signal, undefined, ctx))
		},
	})
})

afterEach(() => {
	vi.clearAllTimers()
	vi.useRealTimers()
	rmSync(root, { recursive: true, force: true })

	for (const key of envKeys) {
		if (savedEnv[key] === undefined) Reflect.deleteProperty(process.env, key)
		else process.env[key] = savedEnv[key]
	}
})

async function execute(name: string, params: JsonObject = {}, signal?: AbortSignal) {
	const tool = tools.get(name)

	if (!tool) throw new Error(`Missing tool: ${name}`)

	return tool(params, signal)
}

async function call(name: string, params: JsonObject = {}, signal?: AbortSignal) {
	return resultSchema.parse((await execute(name, params, signal)).structuredContent)
}

function flagValue(command: string[], flag: string) {
	const index = command.indexOf(flag)

	return index < 0 ? undefined : command[index + 1]
}

async function spawn(params: JsonObject = {}) {
	const result = await call("agent_spawn", { prompt: "task", background: true, ...params })

	return getRun(z.string().parse(result.handle))
}

async function tick(ms = 0) {
	vi.advanceTimersByTime(ms)
	await setImmediate() // Drain asynchronous Rex calls without guessing how many microtasks they need.
}

// Real bridge, metadata and transcripts; the typed host supplies only the capabilities the bridge uses.
async function child(run: RunMetadata) {
	const hooks = events<BridgeContext>()
	const childBus = createEventBus()
	const names: string[] = []
	const sent: { message: string; deliverAs?: "steer" | "followUp" }[] = []

	const c = {
		events: childBus,
		idle: true,
		session: SessionManager.open(run.sessionFile, undefined, root),
		names,
		sent,
		emit: (event: keyof LifecycleEvents, reason?: LifecycleEvents["session_shutdown"]["reason"]) =>
			hooks.emit(event, { isIdle: () => c.idle, sessionManager: c.session }, reason),
		begin: async () => {
			c.idle = false
			await c.emit("agent_start")
		},
		reply: async (text: string, stopReason: StopReason = "stop") => {
			c.session.appendMessage({ role: "user", content: "task", timestamp: Date.now() })

			const message: AssistantMessage = {
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

			if (stopReason === "error") message.errorMessage = text
			c.session.appendMessage(message)
			c.idle = true
			await c.emit("agent_settled")
		},
	}

	installBridge(
		{
			events: childBus,
			on: hooks.on,
			setSessionName: (name) => {
				names.push(name)
			},
			sendUserMessage: (message, options) => {
				sent.push({ message, ...options })
			},
		},
		runDirectory(run.handle),
	)
	await c.emit("session_start")

	return c
}

test.each([
	["defaults", {}, []],
	["empty selection", { tools: [] }, []],
	["readonly", { tools: "readonly" }, ["read", "grep", "find", "ls"]],
	["explicit selection", { tools: ["read", "bash"] }, ["read", "bash"]],
] as const)("spawn sends the requested argv to Rex: %s", async (_name, params, expectedTools) => {
	const prompt = "a task with spaces"
	const cwd = join(root, "directory with spaces")

	const run = await spawn({
		...params,
		excludeTools: ["network"],
		cwd,
		model: "child-model",
		thinkingLevel: "high",
		prompt,
	})

	const command = launches[0]?.command ?? []
	expect(launches[0]?.cwd).toBe(cwd)
	expect(flagValue(command, "--session")).toBe(run.sessionFile)
	expect(flagValue(command, "--provider")).toBe("configured")
	expect(flagValue(command, "--model")).toBe("child-model")
	expect(flagValue(command, "--thinking")).toBe("high")
	expect(command.at(-1)).toBe(prompt)

	if (expectedTools.length) {
		expect(new Set(flagValue(command, "--tools")?.split(","))).toEqual(new Set(expectedTools))
	} else {
		expect(command).not.toContain("--tools")
	}

	expect(new Set(flagValue(command, "--exclude-tools")?.split(","))).toEqual(
		new Set([
			"codemode",
			"agent_spawn",
			"agent_send",
			"agent_wait",
			"agent_stop",
			"agent_list",
			"agent_rename",
			"network",
		]),
	)
	expect(command).not.toContain("--no-tools")
	expect(command).not.toContain("--no-builtin-tools")
})

test("spawn snapshots the real shell-leash policy into Rex argv and persists it for resume", async () => {
	const leash = shellLeashHost({ "shell-leash-allow": "git.switch", "shell-leash-deny": "git.push" }, bus)
	leash.start()
	leash.choices.push("Allow fs.rm for session")
	await leash.bash("rm -rf rs")
	const run = await spawn()
	const child = shellLeashHost(policyFlags(run.launchArgs))
	child.start()
	expect(await child.bash("rm -rf rs && git switch topic")).toBeUndefined()
	expect(await child.bash("git push")).toMatchObject({ block: true })
	expect(await child.bash("git checkout main")).toMatchObject({ block: true })
	expect(child.prompts).toHaveLength(0)
	expect(flagValue(launches[0].command, "--shell-leash-default")).toBe("deny")
	expect(flagValue(launches[0].command, "--shell-leash-allow")).toBe("fs.rm,git.switch")

	await parent.emit("session_shutdown", ctx)
	leash.start() // Parent permissions changed, but the resumed child retains its spawn-time snapshot.
	await parent.emit("session_start", ctx)
	expect(policyFlags(launches[1].command.slice(launches[1].command.indexOf("--shell-leash-default")))).toEqual(
		policyFlags(run.launchArgs.slice(run.launchArgs.indexOf("--shell-leash-default"))),
	)
})

test("a policy snapshot failure prevents launching a child", async () => {
	registerChildPolicy(bus, () => {
		throw new Error("Invalid shell-leash policy")
	})
	await expect(spawn()).rejects.toThrow("Invalid shell-leash policy")
	expect(launches).toHaveLength(0)
	expect(listRuns()).toHaveLength(0)
})

test.each(["all", "builtin"] as const)("spawn forwards noTools=%s to Rex", async (noTools) => {
	await spawn({ noTools })
	const command = launches[0]?.command ?? []
	expect(command).toContain(noTools === "all" ? "--no-tools" : "--no-builtin-tools")
	expect(command).not.toContain(noTools === "all" ? "--no-builtin-tools" : "--no-tools")
})

test("shell-leash denial stops the child and reports its reason only after settlement", async () => {
	const run = await spawn()
	const c = await child(run)
	const guard = shellLeashHost({ "shell-leash-default": "deny" }, c.events)
	await c.begin()
	expect(await guard.bash("rm -f")).toMatchObject({ block: true })
	expect(guard.signal.aborted).toBe(true)
	expect(getRun(run.handle).state).toBe("busy")

	// A denial must not look successful even if the last assistant message was a tool call.
	await c.reply("", "toolUse")
	expect(await call("agent_wait", { handle: run.handle })).toMatchObject({
		status: "error",
		error: "shell-leash policy denies: fs.rm. The current run has been stopped.",
	})
	expect(blocks.has(run.blockId)).toBe(true)

	// A later, explicitly started run does not inherit the previous denial.
	await call("agent_send", { handle: run.handle, message: "Do a read-only task" })
	await tick(250)
	await c.begin()
	await c.reply("Read-only task complete")
	expect(await call("agent_wait", { handle: run.handle })).toMatchObject({ status: "success" })
})

test("a legacy bridge marking the denied child idle does not hide the denial reason", async () => {
	const run = await spawn()
	const c = await child(run)
	const guard = shellLeashHost({ "shell-leash-default": "deny" }, c.events)
	await c.begin()
	await guard.bash("rm -f")
	await c.reply("The operation was aborted.", "error")
	// An installed older bridge can also receive agent_settled after the explicit local bridge.
	updateMetadata(runDirectory(run.handle), { state: "idle" })
	expect(await call("agent_wait", { handle: run.handle })).toMatchObject({
		status: "error",
		error: "shell-leash policy denies: fs.rm. The current run has been stopped.",
	})
})

test("a denial that settles before launch metadata arrives is still reported to the parent", async () => {
	const run = await spawn()
	rmSync(join(runDirectory(run.handle), "metadata.json"))
	const c = await child(run)
	const guard = shellLeashHost({ "shell-leash-default": "deny" }, c.events)
	await c.begin()
	await guard.bash("rm -f")
	await c.reply("", "toolUse")
	writeMetadata(run)
	await tick(250)
	expect(await call("agent_wait", { handle: run.handle })).toMatchObject({
		status: "error",
		error: "shell-leash policy denies: fs.rm. The current run has been stopped.",
	})
})

test.each(["stop", "error", "aborted"] as const)(
	"wait returns the bridge's settled reply (%s), including for rebranded Pi",
	async (reason) => {
		const run = await spawn()
		const c = await child(run)
		await c.begin()
		await c.reply("ANSWER", reason)
		const result = await execute("agent_wait", { handle: run.handle })
		expect(result.structuredContent).toMatchObject({
			answer: "ANSWER",
			status: reason === "stop" ? "success" : reason,
			usage: { totalTokens: 5 },
		})
		expect(Boolean(result.isError)).toBe(reason !== "stop")
		expect(result.usage).toEqual({
			input: 2,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		})
	},
)

test("wait selects the active branch rather than a newer abandoned answer", async () => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("ACTIVE ANSWER")
	const active = c.session.getLeafId()

	if (!active) throw new Error("Missing active branch leaf")
	await c.reply("ABANDONED FAILURE", "error")
	c.session.branch(active)
	// Persist the selected branch without adding another assistant answer.
	c.session.appendCustomEntry("branch-selected")
	expect(await call("agent_wait", { handle: run.handle })).toMatchObject({
		status: "success",
		answer: "ACTIVE ANSWER",
	})
})

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

test("wait timeout leaves the child alive and invalid deadlines are rejected", async () => {
	const run = await spawn()
	const c = await child(run)
	const waiting = call("agent_wait", { handle: run.handle, timeoutSec: 1 })
	await tick()
	await c.begin()
	await tick(500)
	await tick(500)
	expect(await waiting).toMatchObject({ status: "error", error: "timeout after 1s" })
	expect(blocks.has(run.blockId)).toBe(true)
	await expect(call("agent_wait", { handle: run.handle, timeoutSec: 0 })).rejects.toThrow("Invalid parameters")
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
	await c.emit("session_shutdown", "resume")
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

test("resume launches the preserved transcript with its restrictions and without replaying the prompt", async () => {
	const prompt = "initial task must not be replayed"
	const run = await spawn({ prompt, tools: ["read"], excludeTools: ["network"], noTools: "builtin" })
	const c = await child(run)
	await c.begin()
	await c.reply("SAVED HISTORY")
	const transcript = readFileSync(run.sessionFile, "utf8")
	await parent.emit("session_shutdown", ctx, "quit")
	await c.emit("session_shutdown", "quit")
	expect(blocks.has(run.blockId)).toBe(false)
	expect(getRun(run.handle).suspended).toBe(true)
	await parent.emit("session_start", ctx)
	const resumed = getRun(run.handle)
	const command = launches[1]?.command ?? []
	expect(launches).toHaveLength(2)
	expect(blocks.size).toBe(1)
	expect(blocks.has(resumed.blockId)).toBe(true)
	expect(resumed.suspended).toBe(false)
	expect(flagValue(command, "--session")).toBe(run.sessionFile)
	expect(readFileSync(run.sessionFile, "utf8")).toBe(transcript)
	expect(new Set(flagValue(command, "--tools")?.split(","))).toEqual(new Set(["read"]))
	expect(new Set(flagValue(command, "--exclude-tools")?.split(","))).toEqual(
		new Set([
			"codemode",
			"agent_spawn",
			"agent_send",
			"agent_wait",
			"agent_stop",
			"agent_list",
			"agent_rename",
			"network",
		]),
	)
	expect(command).toContain("--no-builtin-tools")
	expect(command).not.toContain(prompt)
})

test("resume does not duplicate a still-live child after close fails", async () => {
	const run = await spawn()
	blocks.set(run.blockId, { exit: null, closeError: "close failed" })
	await expect(parent.emit("session_shutdown", ctx, "quit")).rejects.toThrow("subagent suspend failed")
	expect(blocks.has(run.blockId)).toBe(true)
	expect(getRun(run.handle).suspended).toBe(true)
	await parent.emit("session_start", ctx)
	expect(launches).toHaveLength(1)
	expect(blocks.size).toBe(1)
	expect(getRun(run.handle)).toMatchObject({ blockId: run.blockId, suspended: false })
})

test.each(["quit", "resume"] as const)("bridge releases its polling timer on %s", async (reason) => {
	const run = await spawn()
	const baseline = vi.getTimerCount()
	const c = await child(run)
	expect(vi.getTimerCount()).toBeGreaterThan(baseline)
	await c.emit("session_shutdown", reason)
	expect(vi.getTimerCount()).toBe(baseline)
	await call("agent_send", { handle: run.handle, message: "not delivered after shutdown" })
	await tick(1000)
	expect(c.sent).toEqual([])
})

test.each(["quit", "reload"] as const)("parent releases its widget timer on %s", async (reason) => {
	const widgets: (string[] | undefined)[] = []
	ctx.hasUI = true
	ctx.ui = {
		setWidget: (_key, lines) => {
			widgets.push(lines)
		},
		theme: { fg: (_color, text) => text },
		notify: unexpectedUI,
		custom: unexpectedUI,
	}
	await spawn()
	const baseline = vi.getTimerCount()
	await parent.emit("session_start", ctx)
	expect(vi.getTimerCount()).toBeGreaterThan(baseline)
	await parent.emit("session_shutdown", ctx, reason)
	expect(vi.getTimerCount()).toBe(baseline)
	const writes = widgets.length
	let inspections = 0
	onProcess = () => {
		inspections++
	}

	await tick(2000)
	expect(inspections).toBe(0)
	expect(widgets).toHaveLength(writes)
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
	blocks.delete(failed.blockId)
	expect(await readProcess(exec, failed.blockId)).toMatchObject({ exists: false, alive: false })
	await expect(call("agent_send", { handle: failed.handle, message: "no" })).rejects.toThrow("not running")
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

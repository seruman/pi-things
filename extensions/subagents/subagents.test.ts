import { afterEach, beforeEach, expect, spyOn, test, vi } from "bun:test"
import { randomUUID } from "node:crypto"
import { messageIdSchema, runHandleSchema, sessionIdSchema } from "../lib/session-delivery/identity"
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import type {
	AssistantMessage,
	JsonObject,
	JsonValue,
	Static,
	StopReason,
	ToolResultMessage,
} from "@earendil-works/pi-ai"
import { type AgentToolResult, type EventBus, SessionManager, createEventBus } from "@earendil-works/pi-coding-agent"
import { Check } from "typebox/value"
import { z } from "zod"
import { registerChildPolicy } from "../shell-leash/child-policy"
import { SessionMailbox, workStatus } from "../lib/session-delivery/mailbox"
import { policyFlags, shellLeashHost } from "../shell-leash/test-host"
import { SOURCE_ENTRY, sourceSchema } from "./accounting"
import { installBridge } from "./bridge"
import { familyPolicy } from "./family"
import { COMPLETION_MARKER, CompletionCoordinator, publishCompletion, readCompletion } from "./completion"
import type { DeliveryService } from "../lib/session-delivery/runtime"
import type { BridgeContext, LifecycleEvents, LifecycleHandler, ParentContext } from "./contracts"
import { installParent } from "./index"
import { isManagedChildLaunch } from "./parent-flags"
import { ProgramStatusReporter } from "./program-status"
import { type Exec, readProcess } from "./rex"
import {
	type RunMetadata,
	getRun,
	listRuns,
	prepareRun,
	readMetadata,
	readRunIdentity,
	runDirectory,
	updateMetadata,
	writeMetadata,
} from "./runs"
import { acknowledgeStop, requestStop, stopAcknowledged, stopRequested } from "./stop"

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
		emit(
			event: keyof LifecycleEvents,
			ctx: Context,
			reason: LifecycleEvents["session_shutdown"]["reason"] = "quit",
			aborted = false,
		) {
			if (event === "session_shutdown") return dispatch(event, { type: event, reason }, ctx)

			if (event === "agent_settled") return dispatch(event, { type: event, aborted }, ctx)

			return dispatch(event, { type: event }, ctx)
		},
	}
}

type Tool = (id: string, params: JsonObject, signal?: AbortSignal) => Promise<AgentToolResult<JsonValue>>

type Block = { exit: number | null; error?: string; closeError?: string }

const jsonSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(jsonSchema), z.record(jsonSchema)]),
)

const resultSchema = z.record(jsonSchema)

const launchRequestSchema = z
	.object({
		session_id: z.string(),
		window_id: z.literal("window:parent"),
		bounds: z.array(z.number()).length(4),
		focus: z.literal(false),
		layout: z.object({
			block: z.object({
				flavor: z.literal("com.superlogical.terminal.shell"),
				label: z.string(),
				options: z.object({ cwd: z.string(), command: z.array(z.string()) }).strict(),
			}),
		}),
	})
	.strict()

const closeRequestSchema = z.object({ session_id: z.string(), block_id: z.string() }).strict()

let root: string

let savedEnv: Record<string, string | undefined>

let savedArgv: string[]

let ctx: ParentContext

let parent: ReturnType<typeof events<ParentContext>>

let parentSession: SessionManager

let toolCounter: number

let bus: EventBus

let reports: string[]

let reporter: ProgramStatusReporter

let tools: Map<string, Tool>

let blocks: Map<string, Block>

let nextBlockId: number

let launches: { cwd: string; command: string[] }[]

let onProcess: (() => void) | undefined

let onLaunch: ((command: string[]) => void | Promise<void>) | undefined

let parentMailbox: SessionMailbox

let staged: Parameters<DeliveryService["stageCompletion"]>[0][]

const envKeys = ["PI_CODING_AGENT_DIR", "PI_SUBAGENT_RUN_DIR", "REX_SESSION", "REX_BLOCK"]

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

	if (args[4] === "session.view") {
		return {
			code: 0,
			stderr: "",
			stdout: JSON.stringify({
				windows: [
					{
						window_id: "window:parent",
						layers: [{ layer_id: "layer:parent", kind: "tiled", blocks: [{ block_id: "block:parent" }] }],
					},
				],
			}),
		}
	}

	if (args[4] === "session.set_layer_state") {
		expect(JSON.parse(args[5] ?? "{}")).toMatchObject({ state: "minimized" })

		return { code: 0, stderr: "", stdout: JSON.stringify({ revision: nextBlockId }) }
	}

	if (args[4] === "session.new_layer") {
		const payload = launchRequestSchema.parse(JSON.parse(args[5] ?? "{}")).layout.block
		launches.push(payload.options)
		await onLaunch?.(payload.options.command)
		const blockId = `block:${++nextBlockId}`
		blocks.set(blockId, { exit: null })

		return {
			code: 0,
			stderr: "",
			stdout: JSON.stringify({ layer_id: `layer:${nextBlockId}`, block_ids: [blockId], revision: nextBlockId }),
		}
	}

	if (args[4] === "block.close") {
		const payload = closeRequestSchema.parse(JSON.parse(args[5] ?? "{}"))
		const block = blocks.get(payload.block_id)

		if (!block) throw new Error(`Block already closed: ${payload.block_id}`)

		if (block.closeError) throw new Error(block.closeError)
		blocks.delete(payload.block_id)

		return { code: 0, stderr: "", stdout: JSON.stringify({ block_id: payload.block_id, revision: nextBlockId }) }
	}

	throw new Error(`Unexpected Rex operation: ${args.join(" ")}`)
}

function unexpectedUI(): never {
	throw new Error("Unexpected UI call in a headless test")
}

beforeEach(() => {
	savedArgv = process.argv
	savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
	root = mkdtempSync(join(tmpdir(), "subagents-test-"))
	process.env.PI_CODING_AGENT_DIR = root
	process.env.REX_SESSION = "session:parent"
	process.env.REX_BLOCK = "block:parent"
	Reflect.deleteProperty(process.env, "PI_SUBAGENT_RUN_DIR")
	vi.useFakeTimers()
	tools = new Map()
	blocks = new Map()
	nextBlockId = 0
	launches = []
	onProcess = undefined
	onLaunch = undefined
	parent = events<ParentContext>()
	parentSession = SessionManager.create(root, root, { id: "parent" })
	parentSession.appendMessage({ role: "user", content: "parent task", timestamp: Date.now() })
	toolCounter = 0
	parentMailbox = new SessionMailbox({ sessionId: sessionIdSchema.parse("parent"), cwd: root }, undefined, familyPolicy)
	staged = []
	bus = createEventBus()
	ctx = {
		cwd: root,
		hasUI: false,
		mode: "print",
		model: { provider: "configured", id: "parent" },
		sessionManager: parentSession,
		ui: { theme: { fg: unexpectedUI }, setWidget: unexpectedUI, notify: unexpectedUI, custom: unexpectedUI },
	}
	reports = []
	reporter = new ProgramStatusReporter({
		write: (data) => {
			reports.push(data)
		},
		isTTY: true,
		env: {},
	})
	installTestParent()
})

function installTestParent(): void {
	installParent(
		{
			appendEntry: (type, data) => {
				parentSession.appendCustomEntry(type, data)
			},
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

				tools.set(tool.name, (id, params, signal) => tool.execute(id, parameters.parse(params), signal, undefined, ctx))
			},
		},
		reporter,
		{
			assertContext(context) {
				expect(context.sessionManager).toBe(parentSession)
			},
			send(to, text, mode, route) {
				parentMailbox.heartbeat(undefined)
				const m = parentMailbox.send(to, text, mode, route)
				parentSession.appendCustomEntry("session-message-sent", m)

				return { status: "queued", messageId: m.id, to: m.to, from: m.from, text: m.text, delivery: m.delivery }
			},
			stageCompletion(input) {
				staged.push(input)

				return messageIdSchema.parse(randomUUID())
			},
		},
	)
}

afterEach(() => {
	process.argv = savedArgv
	reporter.dispose()
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

	const id = `test-${++toolCounter}`
	const pending = tool(id, params, signal)

	if (name === "agent_stop") {
		let finished = false
		void pending.then(
			() => {
				finished = true
			},
			() => {
				finished = true
			},
		)

		while (!finished) await tick(100)
	}

	const result = await pending

	const receipt: ToolResultMessage = {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: result.content,
		isError: result.isError ?? false,
		timestamp: Date.now(),
	}

	if (result.usage) receipt.usage = result.usage
	parentSession.appendMessage(receipt)

	return result
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

	return getRun(runHandleSchema.parse(result.handle))
}

async function tick(ms = 0) {
	vi.advanceTimersByTime(ms)
	await setImmediate() // Drain asynchronous Rex calls without guessing how many microtasks they need.
}

// Bun's .rejects.toThrow() can stall setImmediate while this harness advances fake
// timers. Await rejection outside the matcher, then assert on the settled error.
async function rejectionOf<Result>(pending: Promise<Result>): Promise<Error> {
	try {
		await pending
	} catch (error) {
		if (error instanceof Error) return error

		throw error
	}

	throw new Error("Expected promise to reject")
}

async function child(run: RunMetadata) {
	const hooks = events<BridgeContext>()
	const childBus = createEventBus()
	const names: string[] = []
	const sent: { message: string; deliverAs?: "steer" | "followUp" }[] = []
	let messaging: SessionMailbox | undefined
	hooks.on("session_start", (_event, ctx) => {
		messaging?.dispose()
		messaging = new SessionMailbox(
			{
				sessionId: sessionIdSchema.parse(ctx.sessionManager.getSessionId()),
				sessionFile: ctx.sessionManager.getSessionFile(),
				cwd: root,
			},
			undefined,
			familyPolicy,
		)
		messaging.join("test")
	})
	hooks.on("session_shutdown", () => {
		messaging?.dispose()
	})
	hooks.on("agent_start", () => {
		messaging?.heartbeat(undefined)
	})
	hooks.on("agent_settled", () => {
		messaging?.heartbeat(undefined)
	})

	const c = {
		get messaging() {
			if (!messaging) throw new Error("Missing mailbox")

			return messaging
		},
		events: childBus,
		idle: true,
		abortRequests: 0,
		session: SessionManager.open(run.sessionFile, undefined, root),
		names,
		sent,
		emit: (event: keyof LifecycleEvents, reason?: LifecycleEvents["session_shutdown"]["reason"], aborted = false) =>
			hooks.emit(
				event,
				{
					isIdle: () => c.idle,
					abort: () => {
						c.abortRequests++
					},
					sessionManager: c.session,
				},
				reason,
				aborted,
			),
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
		},
		runDirectory(run.handle),
	)
	const admitted: ReturnType<SessionMailbox["receive"]> = []

	const deliveryTimer = setInterval(() => {
		if (!messaging) return
		parentMailbox.heartbeat(undefined)

		for (const m of messaging.receive(() => {})) {
			admitted.push(m)
			messaging.transition(m, { kind: "submitted" })
			updateMetadata(runDirectory(run.handle), { state: "busy" }, ["error"])
			const input: (typeof sent)[number] = { message: m.text }

			if (!c.idle) input.deliverAs = m.delivery === "followUp" ? "followUp" : "steer"
			sent.push(input)
		}
	}, 200)

	hooks.on("agent_settled", () => {
		for (const message of admitted.splice(0)) messaging?.transition(message, { kind: "settled" })
	})
	hooks.on("session_shutdown", () => clearInterval(deliveryTimer))
	await c.emit("session_start")

	return c
}

// Rewrites the owner on disk, as a foreign writer or a case-folded shared folder would.
function disown(run: RunMetadata, owner: string): void {
	const path = join(runDirectory(run.handle, run.parentSessionId), "metadata.json")
	writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), parentSessionId: owner }))
}

function foreignRun(owner: string): RunMetadata {
	const parentSessionId = sessionIdSchema.parse(owner)
	const prepared = prepareRun(parentSessionId)

	const run: RunMetadata = {
		version: 1,
		...prepared,
		parentSessionId,
		blockId: "block:foreign",
		cwd: root,
		provider: "configured",
		model: "parent",
		thinking: "off",
		launchArgs: [],
		createdAt: new Date().toISOString(),
	}

	writeMetadata(run)

	return run
}

test("a new run lands under its parent and the child is handed that directory", async () => {
	const run = await spawn()
	const directory = join(root, "subagents", "by-parent", "parent", run.handle)
	expect(runDirectory(run.handle, run.parentSessionId)).toBe(directory)
	expect(runDirectory(run.handle)).toBe(directory)
	expect(run.sessionFile).toBe(join(directory, "session.jsonl"))
	expect(readdirSync(join(root, "subagents"))).toEqual(["by-parent"])
	expect(launches.at(-1)?.command).toContain(`PI_SUBAGENT_RUN_DIR=${directory}`)
})

test("a session's timers and listings never open another session's runs", async () => {
	const own = await spawn()
	const foreign = foreignRun("other")
	const flat = join(root, "subagents", "abc123")
	mkdirSync(flat)
	const flatMetadata = JSON.stringify({ ...foreign, handle: "abc123", parentSessionId: "parent" })
	writeFileSync(join(flat, "metadata.json"), flatMetadata)
	const spies = (["readFileSync", "readdirSync", "existsSync", "statSync"] as const).map((name) => spyOn(fs, name))
	let opened: string[] = []

	try {
		await parent.emit("session_start", ctx)
		await tick(6000)
		expect((await call("agent_list", { includeStopped: true })).runs).toEqual([
			expect.objectContaining({ handle: own.handle }),
		])
		await call("agent_rename", { handle: own.handle, name: "mine" })
		await expect(call("agent_rename", { handle: foreign.handle, name: "stolen" })).rejects.toThrow("Unknown subagent")
		opened = spies.flatMap((spy) => spy.mock.calls.map((args) => String(args[0])))
	} finally {
		for (const spy of spies) spy.mockRestore()
	}

	const mine = join(root, "subagents", "by-parent", "parent")
	expect(opened.filter((path) => path.startsWith(mine)).length).toBeGreaterThan(30)
	expect(opened.filter((path) => path.startsWith(join(root, "subagents")) && !path.startsWith(mine))).toEqual([])
	expect(readFileSync(join(flat, "metadata.json"), "utf8")).toBe(flatMetadata)
	expect(
		listRuns()
			.map((run) => run.handle)
			.sort(),
	).toEqual([own.handle, foreign.handle].sort())
})

test("runs sharing a parent folder are still filtered by their recorded owner", async () => {
	const run = await spawn()
	const shared = await spawn()
	// "PARENT" and "parent" are one folder on a case-insensitive filesystem.
	disown(shared, "PARENT")
	expect(listRuns(sessionIdSchema.parse("parent")).map((r) => r.handle)).toEqual([run.handle])
	expect((await call("agent_list", { includeStopped: true })).runs).toEqual([
		expect.objectContaining({ handle: run.handle }),
	])
	await expect(call("agent_stop", { handle: shared.handle })).rejects.toThrow("belongs to another parent")
	updateMetadata(runDirectory(run.handle, run.parentSessionId), { parentSessionId: sessionIdSchema.parse("thief") })
	expect(getRun(run.handle).parentSessionId).toBe(sessionIdSchema.parse("parent"))
})

test.each(["", ".", "..", "../escape", "a/b", "a b", "-lead", "trail.", "x".repeat(201)])(
	"a session id unusable as a directory name refuses to spawn: %p",
	async (id) => {
		const owner = sessionIdSchema.parse(id)
		expect(() => prepareRun(owner)).toThrow("not usable")
		expect(listRuns(owner)).toEqual([])
		// The session is recreated for every test.
		parentSession.getSessionId = () => id
		await expect(execute("agent_spawn", { prompt: "task", background: true })).rejects.toThrow("not usable")
		expect(existsSync(join(root, "subagents"))).toBe(false)
		expect(launches).toEqual([])
	},
)

test("a prepared run without metadata is not listed", () => {
	const prepared = prepareRun(sessionIdSchema.parse("parent"))
	expect(existsSync(prepared.sessionFile)).toBe(true)
	expect(listRuns(sessionIdSchema.parse("parent"))).toEqual([])
	expect(listRuns()).toEqual([])
})

test("private handles reject an unrelated parent before changing a child", async () => {
	const run = await spawn()
	disown(run, "unrelated")
	await expect(call("agent_rename", { handle: run.handle, name: "stolen" })).rejects.toThrow(/owner|parent/i)
	expect(getRun(run.handle).name).toBeUndefined()
})

test("actual child settlement persists a sequenced completion fact", async () => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("completed privately")
	const path = join(runDirectory(run.handle), "completion.json")
	expect(existsSync(path)).toBe(true)
	const fact = JSON.parse(readFileSync(path, "utf8"))
	expect(fact).toMatchObject({ sequence: 1, outcome: "success", sessionFile: c.session.getSessionFile() })
	await c.begin()
	await c.reply("completed privately")
	expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ sequence: 2 })
})

test("background completion commits one headless wake across polling and reload", async () => {
	await parent.emit("session_start", ctx)
	const run = await spawn({ noTools: "all" })
	const c = await child(run)
	await c.begin()
	await c.reply("background done")
	await tick(200)
	expect(staged).toHaveLength(1)
	expect(staged[0]?.text).toContain("background done")
	expect(staged[0]?.gate()).toBe("submit")
	await tick(2000)
	expect(staged).toHaveLength(1)
	await parent.emit("session_shutdown", ctx, "reload")
	parent = events<ParentContext>()
	installTestParent()
	await parent.emit("session_start", ctx)
	await tick(1000)
	expect(staged).toHaveLength(1)
	expect(await call("agent_wait", { handle: run.handle })).toMatchObject({ answer: "background done" })
	await tick(1000)
	expect(staged).toHaveLength(1)
	const markers = parentSession.getEntries().filter((e) => e.type === "custom" && e.customType === COMPLETION_MARKER)
	expect(markers).toHaveLength(2)
})

test.each([false, true])(
	"fast completion before launch returns is reserved only for foreground, background %s",
	async (background) => {
		await parent.emit("session_start", ctx)
		onLaunch = async (command) => {
			const file = z.string().parse(flagValue(command, "--session"))

			const directory = z
				.string()
				.parse(command.find((arg) => arg.startsWith("PI_SUBAGENT_RUN_DIR="))?.slice("PI_SUBAGENT_RUN_DIR=".length))

			const identity = readRunIdentity(directory)

			if (!identity) throw new Error("Missing prepared identity")
			expect(readMetadata(directory)).toBeUndefined()

			const run: RunMetadata = {
				...identity,
				version: 1,
				blockId: "fixture-before-launch-response",
				sessionFile: file,
				cwd: root,
				provider: "configured",
				model: "parent",
				thinking: "off",
				launchArgs: [],
				createdAt: new Date().toISOString(),
			}

			const c = await child(run)
			await c.begin()
			await c.reply("fast")
			expect(readCompletion(run)).toMatchObject({ sequence: 1, outcome: "success" })
		}

		const pending = call("agent_spawn", { prompt: "fast", background })
		await tick()
		await tick(500)
		await tick(500)
		const result = await pending

		if (!background) {
			expect(result).toMatchObject({ answer: "fast" })

			for (const item of staged) expect(item.gate()).toBe("withdraw")
		} else expect(staged[0]?.gate()).toBe("submit")
		const count = staged.length
		await tick(1000)
		expect(staged).toHaveLength(count)
	},
)

test("finite consumption leaves later work eligible and retired waiters cannot consume or release new reservations", async () => {
	const coordinator = new CompletionCoordinator(
		{
			appendEntry(type, data) {
				parentSession.appendCustomEntry(type, data)
			},
		},
		{
			stageCompletion(input) {
				staged.push(input)

				return messageIdSchema.parse(randomUUID())
			},
		},
	)

	coordinator.start(ctx)
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("same")
	const waiter = coordinator.invocation(ctx)
	waiter.reserve(run.handle)
	waiter.terminal(readCompletion(getRun(run.handle)))
	await c.begin()
	await c.reply("same")
	waiter.commit()
	waiter.release()
	coordinator.scan()
	expect(staged[0]?.route.sequence).toBe(2)
	const retired = coordinator.invocation(ctx)
	retired.reserve(run.handle)
	retired.terminal(readCompletion(getRun(run.handle)))
	coordinator.stop()
	coordinator.start(ctx)
	expect(() => retired.commit()).toThrow("retired parent")
	expect(staged[0]?.gate()).toBe("withdraw")
	const current = coordinator.invocation(ctx)
	current.reserve(run.handle)
	retired.release()
	coordinator.scan()
	expect(staged[1]?.route.sequence).toBe(2)
	expect(staged[1]?.gate()).toBe("defer")
	current.release()
	expect(staged[1]?.gate()).toBe("submit")
})

test("parallel waits retain separate reservations when one is cancelled", async () => {
	await parent.emit("session_start", ctx)
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	const cancelled = new AbortController()
	const first = call("agent_wait", { handle: run.handle }, cancelled.signal)
	const second = call("agent_wait", { handle: run.handle })
	await tick()
	cancelled.abort()
	await tick(500)
	expect(await first).toMatchObject({ status: "aborted" })
	await c.reply("parallel")
	await tick(200)
	expect(staged[0]?.gate()).toBe("defer")
	await tick(500)
	expect(await second).toMatchObject({ answer: "parallel" })
	expect(staged[0]?.gate()).toBe("withdraw")
	await parent.emit("session_shutdown", ctx, "reload")
	parent = events<ParentContext>()
	installTestParent()
	await parent.emit("session_start", ctx)
	await tick(400)
	expect(staged).toHaveLength(1)
})

test("cancelled and timed out waits consume nothing and a later completion wakes", async () => {
	await parent.emit("session_start", ctx)
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	const waiting = call("agent_wait", { handle: run.handle, timeoutSec: 1 })
	await tick()
	await tick(500)
	await tick(500)
	expect(await waiting).toMatchObject({ status: "error", error: "timeout after 1s" })
	await c.reply("later")
	await tick(200)
	expect(staged[0]?.gate()).toBe("submit")
})

test("inspection failure releases the waiter without consuming the completed child", async () => {
	await parent.emit("session_start", ctx)
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("retained")
	blocks.set(run.blockId, { exit: null, error: "inspection failed" })
	await expect(call("agent_wait", { handle: run.handle })).rejects.toThrow("inspection failed")
	await tick(200)
	expect(staged[0]?.gate()).toBe("submit")
})

test.each(["error", "aborted"] as const)(
	"returned terminal %s consumes its fact without a duplicate wake",
	async (reason) => {
		await parent.emit("session_start", ctx)
		const run = await spawn()
		const c = await child(run)
		await c.begin()
		await c.reply("terminal", reason)
		expect(await call("agent_wait", { handle: run.handle })).toMatchObject({ status: reason })
		await tick(400)
		expect(staged).toEqual([])
	},
)

test("no-response child abort cannot inherit its earlier answer, and identical followups have distinct sequences", async () => {
	await parent.emit("session_start", ctx)
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("same")
	await call("agent_wait", { handle: run.handle })
	await c.begin()
	await c.reply("same")
	expect(readCompletion(getRun(run.handle))?.sequence).toBe(2)
	await tick(200)
	expect(staged[0]?.gate()).toBe("submit")
	await c.begin()
	c.idle = true
	await c.emit("agent_settled", undefined, true)
	expect(await call("agent_wait", { handle: run.handle })).toMatchObject({ status: "aborted", answer: "" })
	expect(readCompletion(getRun(run.handle))).toMatchObject({ sequence: 3, response: { kind: "none" } })
	await tick(400)
	expect(staged).toHaveLength(1)
})

test("an unavailable response anchor is not consumed and cannot block a healthy sibling's wake", async () => {
	await parent.emit("session_start", ctx)
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("retained")
	const fact = readCompletion(getRun(run.handle))

	if (!fact) throw new Error("Missing fact")
	publishCompletion(run, { ...fact, response: { kind: "response", entryId: "missing" } })
	await expect(call("agent_wait", { handle: run.handle })).rejects.toThrow("Completion response identity")
	const healthy = await spawn()
	const sibling = await child(healthy)
	await sibling.begin()
	await sibling.reply("healthy")
	await tick(400)
	expect(staged).toHaveLength(1)
	expect(staged[0]?.route.handle).toBe(healthy.handle)
	publishCompletion(run, fact)
	await tick(200)
	expect(staged).toHaveLength(2)
	expect(staged[1]?.gate()).toBe("submit")
})

test("failed stop releases temporary wake suppression", async () => {
	await parent.emit("session_start", ctx)
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("available")
	blocks.set(run.blockId, { exit: null, error: "cannot inspect" })
	await expect(call("agent_stop", { handle: run.handle })).rejects.toThrow("cannot inspect")
	await tick(200)
	expect(staged[0]?.gate()).toBe("submit")
})

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
	expect(command).toContain(`PI_CODING_AGENT_DIR=${root}`)
	expect(command).toContain(`PI_SUBAGENT_RUN_DIR=${runDirectory(run.handle)}`)
	expect(command.filter((arg) => arg.endsWith("/session-messages/index.ts"))).toHaveLength(0)
	expect(launches[0]?.cwd).toBe(cwd)
	expect(flagValue(command, "--session")).toBe(run.sessionFile)
	expect(run.launchSessionFile).toBe(run.sessionFile)
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

test.each([
	["parent defaults", {}, "configured", "parent"],
	["model override", { model: "child-model" }, "configured", "child-model"],
	["provider override", { provider: "other" }, "other", "parent"],
	["cross-provider model", { provider: "other", model: "vendor/child-model" }, "other", "vendor/child-model"],
] as const)("spawn selects and reports %s", async (_name, params, provider, model) => {
	const result = await call("agent_spawn", { prompt: "task", background: true, ...params })
	const run = getRun(runHandleSchema.parse(result.handle))
	const command = launches[0]?.command ?? []
	expect(flagValue(command, "--provider")).toBe(provider)
	expect(flagValue(command, "--model")).toBe(model)
	expect(run).toMatchObject({ provider, model })
	expect(result.model).toEqual({ provider, id: model })
	expect(await call("agent_list")).toMatchObject({
		runs: [{ handle: run.handle, model: { provider, id: model } }],
	})
	const c = await child(run)
	await c.begin()
	await c.reply("ANSWER")
	expect(await call("agent_wait", { handle: run.handle })).toMatchObject({
		status: "success",
		model: { provider, id: model },
	})
})

test("explicit provider and model work without a parent model", async () => {
	delete ctx.model
	const run = await spawn({ provider: "other", model: "child-model" })
	expect(run).toMatchObject({ provider: "other", model: "child-model" })
	expect(flagValue(launches[0].command, "--provider")).toBe("other")
	expect(flagValue(launches[0].command, "--model")).toBe("child-model")
})

test.each([
	[{}, "No provider specified"],
	[{ model: "child-model" }, "No provider specified"],
	[{ provider: "other" }, "No model specified"],
] as const)("spawn rejects incomplete model selection without parent defaults: %j", async (params, error) => {
	delete ctx.model
	await expect(spawn(params)).rejects.toThrow(error)
	expect(launches).toHaveLength(0)
	expect(listRuns()).toHaveLength(0)
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

test("repeated waits charge completed work only once", async () => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("DONE")
	const first = await execute("agent_wait", { handle: run.handle })
	const second = await execute("agent_wait", { handle: run.handle })
	expect((first.usage?.totalTokens ?? 0) + (second.usage?.totalTokens ?? 0)).toBe(5)
	expect(second.structuredContent).toMatchObject({ usage: { totalTokens: 5 }, usageScope: "session-cumulative" })
})

test("follow-up waits return cumulative data but charge only newly completed work", async () => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("FIRST")
	expect((await execute("agent_wait", { handle: run.handle })).usage?.totalTokens).toBe(5)
	await call("agent_send", { handle: run.handle, message: "follow up" })
	await tick(250)
	await c.begin()
	await c.reply("SECOND")
	const result = await execute("agent_wait", { handle: run.handle })
	expect(result.usage?.totalTokens).toBe(5)
	expect(result.structuredContent).toMatchObject({ usage: { totalTokens: 10 } })
})

test.each([false, true])("stop saves interrupted usage before closing (follow-up: %s)", async (followUp) => {
	const run = await spawn()
	const c = await child(run)

	if (followUp) {
		await c.begin()
		await c.reply("FIRST")
		expect((await execute("agent_wait", { handle: run.handle })).usage?.totalTokens).toBe(5)
	}

	await c.begin()
	const stopping = execute("agent_stop", { handle: run.handle })

	for (let attempt = 0; attempt < 10 && c.abortRequests === 0; attempt++) await tick(100)
	// A live response exists only in the child until abort finishes and Pi saves it.
	expect(blocks.has(run.blockId)).toBe(true)
	expect(getRun(run.handle).stoppedAt).toBeUndefined()
	expect(c.abortRequests).toBe(1)
	await c.reply("PARTIAL STREAM", "aborted")
	await tick(250)
	const result = await stopping
	expect(result.usage?.totalTokens).toBe(5)
	expect(readFileSync(run.sessionFile, "utf8")).toContain("PARTIAL STREAM")
	expect(blocks.has(run.blockId)).toBe(false)
	expect((await execute("agent_stop", { handle: run.handle })).usage).toBeUndefined()
})

test("stop timeout keeps the child alive, blocks new inbox delivery, and allows a graceful retry", async () => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await call("agent_send", { handle: run.handle, message: "queued", followUp: true })
	expect((await rejectionOf(call("agent_stop", { handle: run.handle }))).message).toContain("force: true")
	expect(c.abortRequests).toBe(1)
	expect(c.sent).toEqual([])
	expect(blocks.has(run.blockId)).toBe(true)
	expect(getRun(run.handle).stoppedAt).toBeUndefined()
	await expect(call("agent_send", { handle: run.handle, message: "more" })).rejects.toThrow("stopping")
	await c.reply("DELAYED ABORT", "aborted")
	expect((await execute("agent_stop", { handle: run.handle })).usage?.totalTokens).toBe(5)
	expect(c.sent).toEqual([])
	expect(blocks.has(run.blockId)).toBe(false)
})

test("force stops an unresponsive child without requiring process inspection or acknowledgement", async () => {
	const run = await spawn()
	blocks.set(run.blockId, { exit: null, error: "inspection unavailable" })
	const result = await call("agent_stop", { handle: run.handle, force: true })
	expect(result).toEqual({ handle: run.handle, sessionFile: run.sessionFile })
	expect(blocks.has(run.blockId)).toBe(false)
	expect(getRun(run.handle).stoppedAt).toBeString()
	expect(stopRequested(run)).toBe(false)
	expect(await call("agent_stop", { handle: run.handle, force: true })).toEqual(result)
})

test("force after a stop timeout retains completed history without recharging it", async () => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("COMPLETED")
	expect((await execute("agent_wait", { handle: run.handle })).usage?.totalTokens).toBe(5)
	await c.begin()
	expect((await rejectionOf(call("agent_stop", { handle: run.handle }))).message).toContain("10 seconds")
	expect((await execute("agent_stop", { handle: run.handle, force: true })).usage).toBeUndefined()
	expect(c.abortRequests).toBe(1)
	expect(readFileSync(run.sessionFile, "utf8")).toContain("COMPLETED")
	expect(blocks.has(run.blockId)).toBe(false)
})

test("cancelled stop leaves the requested child alive for a retry or force", async () => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	const controller = new AbortController()
	const stopping = call("agent_stop", { handle: run.handle }, controller.signal)
	const rejected = rejectionOf(stopping)

	for (let attempt = 0; attempt < 10 && c.abortRequests === 0; attempt++) await tick(100)
	controller.abort()
	await rejected
	expect(blocks.has(run.blockId)).toBe(true)
	expect(getRun(run.handle).stoppedAt).toBeUndefined()
	await call("agent_stop", { handle: run.handle, force: true })
	expect(blocks.has(run.blockId)).toBe(false)
})

test("a stale acknowledgement from another Rex block cannot authorize closing a busy child", async () => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	acknowledgeStop({ ...run, blockId: "block:previous-process" })
	expect((await rejectionOf(call("agent_stop", { handle: run.handle }))).message).toContain("10 seconds")
	expect(blocks.has(run.blockId)).toBe(true)
	await call("agent_stop", { handle: run.handle, force: true })
})

test("a stop request aborts late-starting work and revokes an earlier idle acknowledgement", async () => {
	const run = await spawn()
	const c = await child(run)
	requestStop(run)
	await tick(250)
	expect(stopAcknowledged(run)).toBe(true)
	await c.begin()
	expect(stopAcknowledged(run)).toBe(false)
	expect(c.abortRequests).toBe(2)
	await c.reply("ABORTED LATE START", "aborted")
	expect(stopAcknowledged(run)).toBe(true)
	await call("agent_stop", { handle: run.handle })
})

test("stop without waiting accounts for completed work and cache warming after the last wait", async () => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("DONE")
	const first = await execute("agent_wait", { handle: run.handle })

	const warm = {
		input: 0,
		output: 0,
		cacheRead: 10,
		cacheWrite: 0,
		totalTokens: 10,
		cost: { input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.01 },
	}

	c.session.appendUsage("cache_warm", "warm-provider", "warm-model", warm)
	const stop = await execute("agent_stop", { handle: run.handle })
	expect(first.usage?.totalTokens).toBe(5)
	expect(stop.usage).toEqual(warm)
	expect((await execute("agent_stop", { handle: run.handle })).usage).toBeUndefined()
	const other = await spawn()
	const second = await child(other)
	await second.begin()
	await second.reply("NO WAIT")
	expect((await execute("agent_stop", { handle: other.handle })).usage?.totalTokens).toBe(5)
})

test("headless polling records background usage; shutdown reconciles tails and reload delivers them once", async () => {
	await parent.emit("session_start", ctx)
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("BACKGROUND")
	await tick(5000)

	const sources = () =>
		parentSession
			.getEntries()
			.flatMap((entry) =>
				entry.type === "custom" && entry.customType === SOURCE_ENTRY ? [sourceSchema.parse(entry.data)] : [],
			)

	expect(sources()).toHaveLength(1)
	await c.reply("SHUTDOWN TAIL")
	await parent.emit("session_shutdown", ctx)
	expect(sources()).toHaveLength(2)
	parentSession = SessionManager.open(z.string().parse(parentSession.getSessionFile()), root, root)
	ctx.sessionManager = parentSession
	parent = events<ParentContext>()
	installTestParent()
	await parent.emit("session_start", ctx)
	expect((await execute("agent_list")).usage?.totalTokens).toBe(10)
	expect((await execute("agent_list")).usage).toBeUndefined()
	await parent.emit("session_shutdown", ctx)
})

test("parallel waits reserve each source only once before their tool results are persisted", async () => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("DONE")

	const results = await Promise.all([
		execute("agent_wait", { handle: run.handle }),
		execute("agent_wait", { handle: run.handle }),
	])

	expect(results.reduce((total, result) => total + (result.usage?.totalTokens ?? 0), 0)).toBe(5)
})

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

test("session mail blocks old success through queued and submitted states, but passive does not", async () => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("OLD")
	const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("independent-peer"), cwd: root })
	peer.join("test")
	const message = peer.send(sessionIdSchema.parse(c.session.getSessionId()), "new work")
	let finished = false

	const waiting = call("agent_wait", { handle: run.handle }).then((result) => {
		finished = true

		return result
	})

	await tick(500)
	expect(finished).toBe(false)
	c.messaging.receive(() => {})
	c.messaging.transition(message, { kind: "submitted" })
	await tick(500)
	expect(finished).toBe(false)
	await c.begin()
	await c.reply("NEW")
	c.messaging.transition(message, { kind: "settled" })
	await tick(500)
	expect(await waiting).toMatchObject({ status: "success", answer: "NEW" })
	peer.send(sessionIdSchema.parse(c.session.getSessionId()), "passive", "passive")
	expect(workStatus({ sessionId: sessionIdSchema.parse(c.session.getSessionId()) }).kind).toBe("idle")
	expect(await call("agent_wait", { handle: run.handle })).toMatchObject({ status: "success", answer: "NEW" })
})

test("wait pins messaging instance and reports replacement rather than old success", async () => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("OLD")
	const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("peer"), cwd: root })
	peer.join("test")
	peer.send(sessionIdSchema.parse(c.session.getSessionId()), "work")
	const waiting = call("agent_wait", { handle: run.handle })
	await tick(500)
	await c.emit("session_shutdown", "reload")
	await c.emit("session_start")
	await tick(500)
	expect(await waiting).toMatchObject({ status: "error", error: "Messaging receiver replaced or ambiguous" })
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
	const c = await child(run)
	await c.begin()
	await c.reply("PARTIAL HISTORY", "aborted")
	const transcript = readFileSync(run.sessionFile, "utf8")
	controller.abort()

	for (let attempt = 0; attempt < 15; attempt++) await tick(100)
	expect(await spawning).toMatchObject({ status: "aborted" })
	expect(blocks.has(run.blockId)).toBe(false)
	expect(getRun(run.handle).stoppedAt).toBeString()
	await parent.emit("session_shutdown", ctx)
	await parent.emit("session_start", ctx)
	expect(launches).toHaveLength(1)
	expect(readFileSync(run.sessionFile, "utf8")).toBe(transcript)
})

test("failed close after foreground cancellation preserves history without marking the child stopped", async () => {
	const controller = new AbortController()
	const spawning = call("agent_spawn", { prompt: "task" }, controller.signal)
	await tick()
	const run = listRuns()[0]

	if (!run) throw new Error("Missing spawned run")
	const c = await child(run)
	await c.begin()
	await c.reply("CANCELLED HISTORY", "aborted")
	blocks.set(run.blockId, { exit: null, closeError: "close failed" })

	const rejected = spawning.catch((error) => {
		if (error instanceof Error) return error
		throw error
	})

	controller.abort()

	for (let attempt = 0; attempt < 15; attempt++) await tick(100)
	expect(await rejected).toMatchObject({ message: "close failed" })
	expect(getRun(run.handle).stoppedAt).toBeUndefined()
	expect(blocks.has(run.blockId)).toBe(true)
	expect(readFileSync(run.sessionFile, "utf8")).toContain("CANCELLED HISTORY")
	blocks.set(run.blockId, { exit: null })
	await call("agent_stop", { handle: run.handle })
	expect(getRun(run.handle).stoppedAt).toBeString()
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
	expect(getRun(run.handle).launchSessionFile).toBe(run.sessionFile)
	expect(getRun(run.handle).sessionFiles).toEqual([run.sessionFile, z.string().parse(c.session.getSessionFile())])
	expect(await call("agent_wait", { handle: run.handle })).toMatchObject({ answer: "NEW SESSION", name: "renamed" })
	await c.emit("session_shutdown", "quit")
	expect(getRun(run.handle).state).toBe("exited")
})

test("shared inbox rejects malformed files without poisoning private tasks, and delivers each delegation once", async () => {
	const run = await spawn()
	const c = await child(run)
	const inbox = join(c.messaging.root, c.messaging.endpoint.instanceId, "inbox")
	writeFileSync(join(inbox, "bad.json"), "{")
	await tick(250)
	expect(readdirSync(inbox)).toEqual([])
	expect(workStatus({ sessionId: sessionIdSchema.parse(c.session.getSessionId()) }, undefined, familyPolicy).kind).toBe(
		"idle",
	)
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

test("spawn inherits parent extension isolation and persists it when resumed from a different invocation", async () => {
	process.argv = [
		process.execPath,
		"pi",
		"-ne",
		"-e",
		".",
		"-e",
		"builtin:codemode",
		"--session",
		"parent-session",
		"parent prompt",
	]
	const run = await spawn({ cwd: root })
	const launched = launches[0]?.command ?? []
	expect(launched).toContain("--no-extensions")
	expect(run.launchArgs).toEqual(
		expect.arrayContaining(["--no-extensions", "--extension", process.cwd(), "builtin:codemode"]),
	)
	expect(launched).not.toContain("parent-session")
	expect(launched).not.toContain("parent prompt")
	const c = await child(run)
	await c.begin()
	await c.reply("saved")
	await parent.emit("session_shutdown", ctx)
	process.argv = [process.execPath, "pi"]
	await parent.emit("session_start", ctx)
	const resumed = launches[1]?.command ?? []
	expect(resumed).toContain("--no-extensions")
	expect(resumed).toContain(process.cwd())
	expect(resumed).toContain("builtin:codemode")
	expect(getRun(run.handle).launchArgs).toEqual(run.launchArgs)
})

test("resume publishes changed transcript launch identity before Rex, preserving restrictions without replay", async () => {
	const prompt = "initial task must not be replayed"

	const run = await spawn({
		prompt,
		provider: "other",
		model: "child-model",
		tools: ["read"],
		excludeTools: ["network"],
		noTools: "builtin",
	})

	const c = await child(run)
	await c.begin()
	await c.reply("SAVED HISTORY")
	await c.emit("session_shutdown", "new")
	c.session = SessionManager.create(root, root)
	await c.emit("session_start")
	await c.begin()
	await c.reply("NEW SESSION HISTORY")
	const currentFile = z.string().parse(c.session.getSessionFile())
	expect(currentFile).not.toBe(run.sessionFile)
	expect(getRun(run.handle).launchSessionFile).toBe(run.sessionFile)
	requestStop(run)
	acknowledgeStop(run)
	const transcript = readFileSync(currentFile, "utf8")
	await parent.emit("session_shutdown", ctx, "quit")
	await c.emit("session_shutdown", "quit")
	expect(blocks.has(run.blockId)).toBe(false)
	expect(getRun(run.handle).suspended).toBe(true)
	ctx.model = { provider: "changed-parent-provider", id: "changed-parent-model" }
	onLaunch = (command) => {
		expect(getRun(run.handle).launchSessionFile).toBe(currentFile)
		expect(flagValue(command, "--session")).toBe(currentFile)
		expect(isManagedChildLaunch(runDirectory(run.handle), command, root)).toBe(true)
		expect(isManagedChildLaunch(runDirectory(run.handle), ["--session", run.sessionFile], root)).toBe(false)
	}

	await parent.emit("session_start", ctx)
	const resumed = getRun(run.handle)
	expect(stopRequested(run)).toBe(false)
	expect(stopAcknowledged(run)).toBe(false)
	const command = launches[1]?.command ?? []
	expect(launches).toHaveLength(2)
	expect(blocks.size).toBe(1)
	expect(blocks.has(resumed.blockId)).toBe(true)
	expect(resumed.suspended).toBe(false)
	expect(resumed).toMatchObject({ provider: "other", model: "child-model" })
	expect(flagValue(command, "--provider")).toBe("other")
	expect(flagValue(command, "--model")).toBe("child-model")
	expect(flagValue(command, "--session")).toBe(currentFile)
	expect(resumed.launchSessionFile).toBe(currentFile)
	expect(readFileSync(currentFile, "utf8")).toBe(transcript)
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
	updateMetadata(runDirectory(run.handle), { sessionFile: join(root, "changed.jsonl") })
	blocks.set(run.blockId, { exit: null, closeError: "close failed" })
	await expect(parent.emit("session_shutdown", ctx, "quit")).rejects.toThrow("subagent suspend failed")
	expect(blocks.has(run.blockId)).toBe(true)
	expect(getRun(run.handle).suspended).toBe(true)
	await parent.emit("session_start", ctx)
	expect(launches).toHaveLength(1)
	expect(blocks.size).toBe(1)
	expect(getRun(run.handle)).toMatchObject({
		blockId: run.blockId,
		suspended: false,
		launchSessionFile: run.sessionFile,
		sessionFile: join(root, "changed.jsonl"),
	})
})

test.each(["quit", "resume"] as const)("bridge releases its polling timer on %s", async (reason) => {
	const run = await spawn()
	const baseline = vi.getTimerCount()
	const c = await child(run)
	expect(vi.getTimerCount()).toBeGreaterThan(baseline)
	await c.emit("session_shutdown", reason)
	expect(vi.getTimerCount()).toBe(baseline)
	await expect(call("agent_send", { handle: run.handle, message: "not delivered after shutdown" })).rejects.toThrow(
		"Offline",
	)
	await tick(1000)
	expect(c.sent).toEqual([])
})

test("cancellation before a new assistant response does not report the previous turn as successful", async () => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("previous success")
	await c.begin()
	c.idle = true
	await c.emit("agent_settled", undefined, true)
	expect(getRun(run.handle).outcome).toBe("aborted")
	await c.emit("session_shutdown", "reload")
	await c.emit("session_start")
	expect(getRun(run.handle).outcome).toBe("aborted")
})

test.each(["stop", "error", "aborted"] as const)(
	"parent reports child %s outcome, rename, queued work and removal through its existing poll",
	async (reason) => {
		ctx.hasUI = true
		ctx.mode = "tui"
		ctx.ui = { ...ctx.ui, setWidget: () => {}, theme: { fg: (_color, text) => text } }
		await parent.emit("session_start", ctx)
		const run = await spawn({ name: "reviewer" })
		await tick(1000)
		expect(reports.at(-1)).toContain(`state=working:id=subagents/${run.handle}`)
		const c = await child(run)
		await c.begin()
		await c.reply("PRIVATE RESPONSE", reason)
		await tick(1000)
		const expected = reason === "stop" ? "done" : reason === "error" ? "error" : "idle"
		expect(reports.at(-1)).toContain(`state=${expected}:id=subagents/${run.handle}`)
		expect(getRun(run.handle).outcome).toBe(reason === "stop" ? "success" : reason)
		expect(reports.join("")).not.toContain(Buffer.from("PRIVATE RESPONSE").toString("base64"))
		const count = reports.length
		await tick(1000)
		expect(reports).toHaveLength(count)
		await call("agent_rename", { handle: run.handle, name: "renamed" })
		await tick(1000)
		expect(reports.at(-1)).toContain(`title=${Buffer.from("renamed").toString("base64")}`)
		await call("agent_send", { handle: run.handle, message: "next turn" })
		await tick(1000)
		expect(reports.at(-1)).toContain(`state=working:id=subagents/${run.handle}`)
		await call("agent_stop", { handle: run.handle, force: true })
		await tick(1000)
		expect(reports.at(-1)).toBe(`\x1b]7501;state=clear:id=subagents/${run.handle}\x1b\\`)
		await parent.emit("session_shutdown", ctx, "reload")
		const finalCount = reports.length
		await tick(2000)
		expect(reports).toHaveLength(finalCount)
	},
)

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

test.each([
	["stop", "exited"],
	["stop", "missing"],
	["shutdown", "exited"],
	["shutdown", "missing"],
])("%s retains history for %s blocks without resuming them", async (action, state) => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("RETAINED")
	const transcript = readFileSync(run.sessionFile, "utf8")

	if (state === "exited") blocks.set(run.blockId, { exit: 0 })
	else blocks.delete(run.blockId)

	if (action === "stop") await call("agent_stop", { handle: run.handle })
	else await parent.emit("session_shutdown", ctx)
	expect(blocks.has(run.blockId)).toBe(false)
	expect(getRun(run.handle).stoppedAt).toBeString()
	await parent.emit("session_shutdown", ctx)
	await parent.emit("session_start", ctx)
	expect(launches).toHaveLength(1)
	expect(readFileSync(run.sessionFile, "utf8")).toBe(transcript)
})

test("stop retains discoverable history, is repeatable, and never resumes or polls stopped children", async () => {
	const run = await spawn({ name: "reviewer" })
	const c = await child(run)
	await c.begin()
	await c.reply("SAVED ANSWER")
	const transcript = readFileSync(run.sessionFile, "utf8")
	const result = await call("agent_stop", { handle: run.handle })
	expect(result).toEqual({ handle: run.handle, sessionFile: run.sessionFile })
	expect(blocks.has(run.blockId)).toBe(false)
	const stopped = getRun(run.handle)
	expect(stopped).toMatchObject({
		parentSessionId: "parent",
		childSessionId: c.session.getSessionId(),
		suspended: false,
	})
	expect(stopped.stoppedAt).toBeString()

	// A late bridge lifecycle update must not undo the parent-owned stop marker.
	await c.emit("agent_settled")
	await c.emit("session_shutdown", "quit")
	onProcess = () => {
		throw new Error("Stopped runs must not query Rex")
	}

	await tick(1000)
	expect(await call("agent_stop", { handle: run.handle })).toEqual(result)
	expect(getRun(run.handle).stoppedAt).toBe(stopped.stoppedAt)
	expect((await call("agent_list")).runs).toEqual([])
	expect((await call("agent_list", { includeStopped: true })).runs).toEqual([
		expect.objectContaining({
			handle: run.handle,
			name: "reviewer",
			state: "stopped",
			stoppedAt: stopped.stoppedAt,
			sessionFile: run.sessionFile,
		}),
	])
	await expect(call("agent_send", { handle: run.handle, message: "no" })).rejects.toThrow("stopped")
	await expect(call("agent_wait", { handle: run.handle })).rejects.toThrow("stopped")
	await parent.emit("session_shutdown", ctx, "reload")
	await parent.emit("session_start", ctx)
	await parent.emit("session_shutdown", ctx, "quit")
	await parent.emit("session_start", ctx)
	expect(launches).toHaveLength(1)
	expect(readFileSync(run.sessionFile, "utf8")).toBe(transcript)
	expect(SessionManager.open(run.sessionFile).getSessionId()).toBe(c.session.getSessionId())
})

test.each(["inspection", "close"])("failed stop during %s preserves history and remains retryable", async (phase) => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("KEEP ME")
	const transcript = readFileSync(run.sessionFile, "utf8")
	blocks.set(run.blockId, {
		exit: null,
		...(phase === "close" ? { closeError: "Rex unavailable" } : { error: "Rex unavailable" }),
	})
	expect((await rejectionOf(call("agent_stop", { handle: run.handle }))).message).toContain("Rex unavailable")
	expect(blocks.has(run.blockId)).toBe(true)
	expect(getRun(run.handle).stoppedAt).toBeUndefined()
	expect(readFileSync(run.sessionFile, "utf8")).toBe(transcript)
	blocks.set(run.blockId, { exit: null })
	await call("agent_stop", { handle: run.handle })
	expect(blocks.has(run.blockId)).toBe(false)
	expect(getRun(run.handle).stoppedAt).toBeString()
})

test("failed shutdown cleanup retains an exited child's history and retries later", async () => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("EXITED HISTORY")
	blocks.set(run.blockId, { exit: 0, closeError: "close failed" })
	await expect(parent.emit("session_shutdown", ctx)).rejects.toThrow("subagent suspend failed")
	expect(getRun(run.handle).stoppedAt).toBeUndefined()
	expect(readFileSync(run.sessionFile, "utf8")).toContain("EXITED HISTORY")
	blocks.set(run.blockId, { exit: 0 })
	await parent.emit("session_shutdown", ctx)
	expect(getRun(run.handle).stoppedAt).toBeString()
	expect(blocks.has(run.blockId)).toBe(false)
})

test("stopping a suspended child cancels automatic resume without deleting its history", async () => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("SUSPENDED HISTORY")
	await parent.emit("session_shutdown", ctx)
	expect(getRun(run.handle).suspended).toBe(true)
	await call("agent_stop", { handle: run.handle })
	await parent.emit("session_start", ctx)
	expect(launches).toHaveLength(1)
	expect(getRun(run.handle)).toMatchObject({ suspended: false, stoppedAt: expect.any(String) })
	expect(readFileSync(run.sessionFile, "utf8")).toContain("SUSPENDED HISTORY")
})

test("a missing transcript on resume retains metadata and stops retrying", async () => {
	const run = await spawn()
	await parent.emit("session_shutdown", ctx)
	rmSync(run.sessionFile)
	await parent.emit("session_start", ctx)
	expect(getRun(run.handle)).toMatchObject({
		parentSessionId: "parent",
		sessionFile: run.sessionFile,
		stoppedAt: expect.any(String),
		suspended: false,
		error: expect.stringContaining("transcript"),
	})
	await parent.emit("session_shutdown", ctx)
	await parent.emit("session_start", ctx)
	expect(launches).toHaveLength(1)
	expect(existsSync(run.sessionFile)).toBe(false)
})

test("failed spawn preserves any launch artifacts instead of deleting them", async () => {
	let sessionFile = ""
	onLaunch = (command) => {
		sessionFile = flagValue(command, "--session") ?? ""
		writeFileSync(sessionFile, "partial child history\n")
		throw new Error("launch response lost")
	}

	await expect(spawn()).rejects.toThrow("launch response lost")
	expect(readFileSync(sessionFile, "utf8")).toBe("partial child history\n")
})

test("stopped history listing stays parent-scoped and does not hide a healthy child", async () => {
	const stopped = await spawn()
	const foreign = await spawn()
	const healthy = await spawn()
	await child(stopped)
	await child(foreign)
	await call("agent_stop", { handle: stopped.handle })
	await call("agent_stop", { handle: foreign.handle })
	disown(foreign, "other")
	expect((await call("agent_list")).runs).toEqual([expect.objectContaining({ handle: healthy.handle })])
	const history = (await call("agent_list", { includeStopped: true })).runs
	expect(history).toHaveLength(2)
	expect(history).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ handle: stopped.handle, state: "stopped" }),
			expect.objectContaining({ handle: healthy.handle }),
		]),
	)
})

test("concurrent stops tolerate another caller closing the block first", async () => {
	const run = await spawn()
	await child(run)

	const results = await Promise.all([
		call("agent_stop", { handle: run.handle }),
		call("agent_stop", { handle: run.handle }),
	])

	expect(results[0]).toEqual(results[1])
	expect(blocks.has(run.blockId)).toBe(false)
	expect(getRun(run.handle).stoppedAt).toBeString()
	expect(existsSync(run.sessionFile)).toBe(true)
})

test("stop keeps the latest session path if the bridge changes it during process inspection", async () => {
	const run = await spawn()
	const c = await child(run)
	await c.begin()
	await c.reply("ORIGINAL")
	await c.emit("session_shutdown", "resume")
	c.session = SessionManager.create(root, root)
	await c.begin()
	await c.reply("LATEST")
	onProcess = () => {
		onProcess = undefined
		void c.emit("session_start")
	}

	const result = await call("agent_stop", { handle: run.handle })
	expect(result.sessionFile).toBe(z.string().parse(c.session.getSessionFile()))
	expect(result.sessionFile).not.toBe(run.sessionFile)
	expect(getRun(run.handle).childSessionId).toBe(sessionIdSchema.parse(c.session.getSessionId()))
	expect(readFileSync(run.sessionFile, "utf8")).toContain("ORIGINAL")
	expect(readFileSync(z.string().parse(result.sessionFile), "utf8")).toContain("LATEST")
})

test("stopped children stay out of the widget even with stale suspended or error state", async () => {
	const run = await spawn()
	await child(run)
	await call("agent_stop", { handle: run.handle })
	updateMetadata(runDirectory(run.handle), { suspended: true, state: "error", error: "previous failure" })
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
	onProcess = () => {
		throw new Error("Stopped runs must not query Rex")
	}

	await parent.emit("session_start", ctx)
	await tick(2000)
	expect(widgets.length).toBeGreaterThan(0)
	expect(widgets.every((lines) => lines === undefined)).toBe(true)
	expect(launches).toHaveLength(1)
	expect((await call("agent_list", { includeStopped: true })).runs).toEqual([
		expect.objectContaining({ handle: run.handle, state: "stopped", error: "previous failure" }),
	])
	await parent.emit("session_shutdown", ctx)
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
	disown(other, "other")
	expect((await call("agent_list")).runs).toEqual([expect.objectContaining({ handle: run.handle })])
	writeFileSync(join(runDirectory(other.handle), "metadata.json"), "{")
	expect(readMetadata(runDirectory(other.handle))).toBeUndefined()
	expect(listRuns()).toHaveLength(1)
	await expect(call("agent_rename", { handle: run.handle, name: "bad\nname" })).rejects.toThrow()
	expect((await rejectionOf(call("agent_stop", { handle: "../escape" }))).message).toContain("Invalid subagent handle")
})

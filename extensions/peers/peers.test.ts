import { afterEach, beforeEach, expect, test, vi } from "bun:test"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import type { JsonObject, JsonValue, Static } from "@earendil-works/pi-ai"
import {
	type AgentToolResult,
	type EventBus,
	type ExtensionAPI,
	Theme,
	SessionManager,
	createEventBus,
} from "@earendil-works/pi-coding-agent"
import { Check } from "typebox/value"
import { z } from "zod"
import { registerChildPolicy } from "../shell-leash/child-policy"
import type { Exec } from "../rex/client"
import { channels, requestPeers } from "./api"
import type { LifecycleEvents, LifecycleHandler, PeersContext } from "./contracts"
import peers, { PEERS_ENTRY, installPeers } from "./index"
import { MESSAGE_TYPE, batchSchema, renderMessage } from "./messages"
import {
	type Peer,
	type PeerMessage,
	inboxDir,
	messageSchema,
	listLivePeers,
	newMessageId,
	peerDir,
	readPeer,
	removeStale,
} from "./registry"

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

const jsonSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(jsonSchema), z.record(jsonSchema)]),
)

const resultSchema = z.record(jsonSchema)

const rexArgsSchema = z
	.object({
		focus: z.boolean(),
		layout: jsonSchema,
		anchor_block_id: z.string().nullable().optional(),
		window_id: z.string().nullable().optional(),
		direction: z.string().optional(),
		side: z.string().optional(),
	})
	.strict()

const messageEventSchema = z.object({ message: messageSchema, claim: z.function().returns(z.void()) })

type Tool = (params: JsonObject, signal?: AbortSignal) => Promise<AgentToolResult<JsonValue>>

interface Sent {
	message: { customType: string; content: unknown; display: boolean; details?: unknown }
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }
}

interface RexCall {
	session: string
	method: string
	args: z.infer<typeof rexArgsSchema>
}

const envKeys = ["PI_CODING_AGENT_DIR", "PI_SUBAGENT_RUN_DIR", "PI_PEERS_LABEL", "PI_PEERS_NAMESPACE"]

let root: string

let savedEnv: Record<string, string | undefined>

let bus: EventBus

let rexCalls: RexCall[]

let rexFailure: string | undefined

let nextBlock: number

const rexCallSchema = z.tuple([
	z.literal("api"),
	z.literal("call"),
	z.literal("-s"),
	z.string(),
	z.string(),
	z.string(),
])

// Only the Rex transport is faked. Anything other than the placement methods fails the test.
const exec: Exec = async (command, args, signal) => {
	signal?.throwIfAborted()
	expect(command).toBe("rex")
	const [, , , session, method, json] = rexCallSchema.parse(args)
	const call = { session, method, args: rexArgsSchema.parse(JSON.parse(json)) }
	rexCalls.push(call)

	if (rexFailure) return { code: 1, stdout: "", stderr: rexFailure }
	const blockId = `block:${++nextBlock}`

	if (method === "session.new_window") {
		return {
			code: 0,
			stderr: "",
			stdout: JSON.stringify({ window_id: "window:new", block_ids: [blockId], revision: 1 }),
		}
	}

	if (method === "session.new_split") {
		return {
			code: 0,
			stderr: "",
			stdout: JSON.stringify({ anchor_block_id: null, block_ids: [blockId], split_ids: ["split:1"], revision: 1 }),
		}
	}

	throw new Error(`Unexpected Rex operation: ${args.join(" ")}`)
}

interface TestPeer {
	id: string
	ctx: PeersContext & { idle: boolean }
	session: SessionManager
	tools: Map<string, Tool>
	sent: Sent[]
	renderers: Set<string>
	emit(event: keyof LifecycleEvents, reason?: LifecycleEvents["session_shutdown"]["reason"]): Promise<void>
	errors: string[]
}

const started: TestPeer[] = []

function createPeer(
	id: string,
	options: { name?: string; rexBlock?: string; label?: string; namespace?: string; events?: EventBus } = {},
): TestPeer {
	const lifecycle = events<PeersContext>()
	const session = SessionManager.create(root, join(root, "sessions"), { id })

	if (options.name) session.appendSessionInfo(options.name)
	const tools = new Map<string, Tool>()
	const sent: Sent[] = []
	const renderers = new Set<string>()
	const errors: string[] = []

	const ctx: TestPeer["ctx"] = {
		cwd: root,
		hasUI: true,
		idle: true,
		isIdle: () => ctx.idle,
		sessionManager: session,
		ui: {
			notify: (message) => {
				errors.push(message)
			},
		},
	}

	installPeers(
		{
			on: lifecycle.on,
			events: options.events ?? bus,
			exec: async (command, args, execOptions) => ({
				...(await exec(command, args, execOptions?.signal)),
				killed: false,
			}),
			appendEntry: (type, data) => {
				session.appendCustomEntry(type, data)
			},
			getSessionName: () => session.getSessionName(),
			sendMessage: (message, sendOptions) => {
				sent.push({ message, options: sendOptions })
			},
			registerMessageRenderer: (type) => {
				renderers.add(type)
			},
			registerTool(tool) {
				// Pi and this repo resolve different TypeBox versions; validate using the declared wire schema.
				const parameters = z.custom<Static<typeof tool.parameters>>(
					(value) => Check(tool.parameters, value),
					`Invalid parameters for ${tool.name}`,
				)

				tools.set(tool.name, (params, signal) => tool.execute("call", parameters.parse(params), signal, undefined, ctx))
			},
		},
		{ rexSession: "session:rex", rexBlock: options.rexBlock, label: options.label, namespace: options.namespace },
	)

	const peer: TestPeer = {
		id,
		ctx,
		session,
		tools,
		sent,
		renderers,
		errors,
		emit: (event, reason) => lifecycle.emit(event, ctx, reason),
	}

	started.push(peer)

	return peer
}

async function startPeer(id: string, options?: Parameters<typeof createPeer>[1]): Promise<TestPeer> {
	const peer = createPeer(id, options)
	await peer.emit("session_start")

	return peer
}

async function tick(ms = 250) {
	vi.advanceTimersByTime(ms)
	await setImmediate()
}

function call(peer: TestPeer, name: string, params: JsonObject = {}) {
	const tool = peer.tools.get(name)

	if (!tool) throw new Error(`No tool ${name}`)

	return tool(params)
}

async function details(peer: TestPeer, name: string, params: JsonObject = {}) {
	return resultSchema.parse((await call(peer, name, params)).details)
}

function texts(sent: Sent | undefined): string[] {
	return batchSchema.parse(sent?.message.details).messages.map((message) => message.text)
}

function inbox(peerId: string): string[] {
	return existsSync(inboxDir(peerId)) ? readdirSync(inboxDir(peerId)).filter((name) => name.endsWith(".json")) : []
}

beforeEach(() => {
	savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
	root = mkdtempSync(join(tmpdir(), "peers-test-"))
	process.env.PI_CODING_AGENT_DIR = root

	for (const key of envKeys.slice(1)) Reflect.deleteProperty(process.env, key)
	vi.useFakeTimers()
	bus = createEventBus()
	rexCalls = []
	rexFailure = undefined
	nextBlock = 0
})

afterEach(async () => {
	for (const peer of started.splice(0)) await peer.emit("session_shutdown")
	vi.useRealTimers()
	rmSync(root, { recursive: true, force: true })

	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) Reflect.deleteProperty(process.env, key)
		else process.env[key] = value
	}
})

test("subagent children are never peers", () => {
	process.env.PI_SUBAGENT_RUN_DIR = join(root, "run")
	const pi = new Proxy({}, { get: (_target, key) => expect.unreachable(`peers touched pi.${String(key)}`) })
	// SAFETY: the proxy fails the test on any property access, so no ExtensionAPI member is ever used.
	peers(pi as ExtensionAPI)
	expect(existsSync(join(root, "peers"))).toBe(false)
})

test("a session registers on start, defaults its label to the session name, and unregisters on shutdown", async () => {
	const peer = await startPeer("alpha", { name: "Alpha work", rexBlock: "block:alpha" })

	expect(readPeer("alpha")).toMatchObject({
		peerId: "alpha",
		label: "Alpha work",
		cwd: root,
		pid: process.pid,
		rex: { sessionId: "session:rex", blockId: "block:alpha" },
		state: "idle",
	})
	expect(peer.renderers.has(MESSAGE_TYPE)).toBe(true)

	await peer.emit("agent_start")
	expect(readPeer("alpha")?.state).toBe("busy")
	await peer.emit("agent_settled")
	expect(readPeer("alpha")?.state).toBe("idle")

	await peer.emit("session_shutdown")
	started.splice(started.indexOf(peer), 1)
	expect(existsSync(peerDir("alpha"))).toBe(false)
})

test("shutdown keeps undelivered messages for the next resume", async () => {
	const peer = await startPeer("alpha")
	const sender = await startPeer("beta")
	peer.ctx.idle = false
	await call(sender, "peer_send", { to: "alpha", text: "later", kind: "note" })
	await peer.emit("session_shutdown")
	started.splice(started.indexOf(peer), 1)

	expect(readPeer("alpha")).toBeUndefined()
	expect(inbox("alpha")).toHaveLength(1)
})

test("stale records are dropped, spawns in progress are kept, and old leftovers expire", () => {
	const now = Date.now()
	const days = (count: number) => (now - count * 24 * 60 * 60 * 1000) / 1000

	const record = (peerId: string, pid: number, age: number) => {
		const peer: Peer = {
			peerId,
			sessionFile: null,
			cwd: root,
			pid,
			rex: null,
			state: "idle",
			updatedAt: new Date().toISOString(),
		}

		mkdirSync(inboxDir(peerId), { recursive: true })
		const path = join(peerDir(peerId), "peer.json")
		writeFileSync(path, JSON.stringify(peer))
		utimesSync(path, days(age), days(age))
	}

	const message = (peerId: string, age: number) => {
		mkdirSync(inboxDir(peerId), { recursive: true })
		const path = join(inboxDir(peerId), `${newMessageId()}.json`)
		writeFileSync(path, "{}")
		utimesSync(path, days(age), days(age))
	}

	const deadPid = 2 ** 22 + 12345

	record("dead", deadPid, 0)
	record("dead-old-inbox", deadPid, 30)
	message("dead-old-inbox", 8)
	// The newest message counts, not peer.json.
	record("dead-recent-inbox", deadPid, 30)
	message("dead-recent-inbox", 30)
	message("dead-recent-inbox", 1)
	record("alive-old", process.pid, 30)
	message("pending", 0)
	mkdirSync(inboxDir("old-spawn"), { recursive: true })
	utimesSync(peerDir("old-spawn"), days(8), days(8))

	expect(listLivePeers().map((peer) => peer.peerId)).toEqual(["alive-old"])
	removeStale(now)
	expect(readdirSync(join(root, "peers")).sort()).toEqual(["alive-old", "dead-recent-inbox", "pending"])
	expect(readPeer("dead-recent-inbox")).toBeUndefined()
	expect(inbox("dead-recent-inbox")).toHaveLength(2)
})

test("namespaces are isolated, and the open pool is one namespace", async () => {
	const open = await startPeer("open1", { name: "first" })
	await startPeer("open2")
	const babysit = await startPeer("bs1", { namespace: "babysit" })
	await startPeer("bs2", { namespace: "babysit", label: "fixer" })

	const openList = await details(open, "peer_list")
	expect(openList).toMatchObject({ self: { peerId: "open1", label: "first" }, peers: [{ peerId: "open2" }] })

	const babysitList = await details(babysit, "peer_list")
	expect(babysitList).toMatchObject({ peers: [{ peerId: "bs2", label: "fixer", namespace: "babysit" }] })

	await expect(call(open, "peer_send", { to: "bs2", text: "hi", kind: "note" })).rejects.toThrow(
		'No live peer "bs2" in this session\'s namespace',
	)
})

test("targets resolve by id, unique label, or Rex block, never self", async () => {
	const sender = await startPeer("sender", { rexBlock: "block:sender" })
	await startPeer("one", { label: "twin", rexBlock: "block:one" })
	await startPeer("two", { label: "twin" })
	await startPeer("three", { label: "solo" })

	expect((await call(sender, "peer_send", { to: "block:one", text: "a", kind: "note" })).details).toMatchObject({
		to: "one",
	})
	expect((await call(sender, "peer_send", { to: "solo", text: "b", kind: "note" })).details).toMatchObject({
		to: "three",
	})
	await expect(call(sender, "peer_send", { to: "twin", text: "c", kind: "note" })).rejects.toThrow(
		'Label "twin" matches several peers: one, two',
	)
	await expect(call(sender, "peer_send", { to: "block:sender", text: "d", kind: "note" })).rejects.toThrow(
		"cannot message itself",
	)
	await expect(call(sender, "peer_send", { to: "one", text: "e", kind: "note", steer: true })).rejects.toThrow(
		"steer only applies to requests",
	)
})

test("pending messages reach an idle peer as one delivery that starts one turn", async () => {
	const target = await startPeer("target")
	const sender = await startPeer("sender", { label: "boss" })
	await call(sender, "peer_send", { to: "target", text: "first", kind: "request" })
	await call(sender, "peer_send", { to: "target", text: "fyi", kind: "note", replyTo: "m1" })
	await call(sender, "peer_send", { to: "target", text: "second", kind: "request", steer: true })
	await tick()

	expect(target.sent).toHaveLength(1)
	expect(target.sent[0]?.options).toEqual({ triggerTurn: true })
	expect(target.sent[0]?.message).toMatchObject({ customType: MESSAGE_TYPE, display: true })
	expect(texts(target.sent[0])).toEqual(["first", "fyi", "second"])
	const content = String(target.sent[0]?.message.content)
	expect(content).toContain("[3 peer messages, oldest first]")
	expect(content).toMatch(/1\. request from boss \(sender\), message id \S+\nfirst/)
	expect(content).toContain("2. note from boss (sender)")
	expect(content).toContain("in reply to m1")
	expect(content).toContain("3. steering request from boss (sender)")
	expect(content).toContain('peer_send({ to: "<sender peer id>"')
	expect(inbox("target")).toEqual([])
	expect(readPeer("target")?.state).toBe("busy")

	// Until the requested turn starts, new messages wait in the inbox for the next batch.
	await call(sender, "peer_send", { to: "target", text: "third", kind: "request" })
	await tick()
	expect(target.sent).toHaveLength(1)

	target.ctx.idle = false
	await target.emit("agent_start")
	await tick()
	expect(target.sent).toHaveLength(1)
	expect(inbox("target")).toHaveLength(1)

	target.ctx.idle = true
	await target.emit("agent_settled")
	expect(target.sent).toHaveLength(2)
	expect(target.sent[1]?.options).toEqual({ triggerTurn: true })
	expect(texts(target.sent[1])).toEqual(["third"])
	expect(String(target.sent[1]?.message.content)).toContain("[1 peer message]")
})

test("busy peers hold messages until settled; steers interrupt at once, combined", async () => {
	const target = await startPeer("target")
	const sender = await startPeer("sender")
	target.ctx.idle = false
	await target.emit("agent_start")
	await call(sender, "peer_send", { to: "target", text: "do it", kind: "request" })
	await call(sender, "peer_send", { to: "target", text: "fyi", kind: "note" })
	await call(sender, "peer_send", { to: "target", text: "stop", kind: "request", steer: true })
	await call(sender, "peer_send", { to: "target", text: "really", kind: "request", steer: true })
	await tick()

	expect(target.sent).toHaveLength(1)
	expect(target.sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" })
	expect(texts(target.sent[0])).toEqual(["stop", "really"])
	expect(inbox("target")).toHaveLength(2)

	// Polls while busy deliver nothing more.
	await tick()
	await tick()
	expect(target.sent).toHaveLength(1)

	target.ctx.idle = true
	await target.emit("agent_settled")
	expect(target.sent).toHaveLength(2)
	expect(target.sent[1]?.options).toEqual({ triggerTurn: true })
	expect(texts(target.sent[1])).toEqual(["do it", "fyi"])
	expect(inbox("target")).toEqual([])
})

test("notes alone are delivered for the next turn without starting one", async () => {
	const target = await startPeer("target")
	const sender = await startPeer("sender")
	await call(sender, "peer_send", { to: "target", text: "one", kind: "note" })
	await call(sender, "peer_send", { to: "target", text: "two", kind: "note" })
	await tick()

	expect(target.sent.map((sent) => sent.options)).toEqual([{ deliverAs: "nextTurn" }])
	expect(texts(target.sent[0])).toEqual(["one", "two"])
	expect(inbox("target")).toEqual([])
	expect(readPeer("target")?.state).toBe("idle")
})

test("the renderer lists every message in a delivery", () => {
	const message = (text: string, kind: PeerMessage["kind"]): PeerMessage => ({
		id: newMessageId(),
		kind,
		steer: false,
		from: { peerId: "sender", label: "boss" },
		text,
		sentAt: new Date().toISOString(),
	})

	const plain = (_color: string, text: string) => text

	// Unstyled output; the renderer only calls fg, bg and bold.
	const theme: Theme = Object.assign(Object.create(Theme.prototype), {
		fg: plain,
		bg: plain,
		bold: plain.bind(null, ""),
	})

	const render = (details: JsonValue, expanded = false) =>
		renderMessage(
			{ role: "custom", customType: MESSAGE_TYPE, content: "", display: true, details, timestamp: 0 },
			{ expanded, outputPad: 0 },
			theme,
		)
			?.render(80)
			.map((line) => line.trimEnd())
			.filter(Boolean)

	expect(render({ messages: [message("do it", "request"), message("fyi", "note")] })).toEqual([
		"2 peer messages",
		"peer request from boss",
		"do it",
		"peer note from boss",
		"fyi",
	])
	expect(render({ messages: [message("solo", "request")] }, true)?.[2]).toStartWith("from sender  id ")
	// Unknown details fall back to pi's default rendering.
	expect(render({ kind: "request" })).toBeUndefined()
})

test("extensions claim single messages once, before batching and even while busy", async () => {
	const target = await startPeer("target")
	const sender = await startPeer("sender")
	const seen: string[] = []
	bus.on(channels.message, (data) => {
		const event = messageEventSchema.parse(data)
		seen.push(event.message.text)

		if (event.message.from.peerId === "sender" && event.message.replyTo === "fix-1") event.claim()
	})

	target.ctx.idle = false
	await target.emit("agent_start")
	await call(sender, "peer_send", { to: "target", text: "done", kind: "request", replyTo: "fix-1" })
	await call(sender, "peer_send", { to: "target", text: "other", kind: "request" })
	await tick()
	await tick()
	expect(seen).toEqual(["done", "other"])
	expect(target.sent).toEqual([])
	expect(inbox("target")).toHaveLength(1)

	target.ctx.idle = true
	await target.emit("agent_settled")
	expect(seen).toEqual(["done", "other"])
	expect(texts(target.sent[0])).toEqual(["other"])
})

test("unreadable messages are reported and removed", async () => {
	const target = await startPeer("target")
	writeFileSync(join(inboxDir("target"), `${newMessageId()}.json`), "{")
	await tick()

	expect(inbox("target")).toEqual([])
	expect(target.errors[0]).toContain("Dropped unreadable peer message")
})

test("peer_set persists label and namespace in the session file and survives resume", async () => {
	const peer = await startPeer("alpha", { name: "named" })
	await startPeer("other", { namespace: "team" })

	expect((await call(peer, "peer_set", { label: "lead", namespace: "team" })).details).toEqual({
		peerId: "alpha",
		label: "lead",
		namespace: "team",
	})
	expect(readPeer("alpha")).toMatchObject({ label: "lead", namespace: "team" })
	expect((await details(peer, "peer_list")).peers).toMatchObject([{ peerId: "other" }])

	const entries = peer.session.getEntries().filter((entry) => entry.type === "custom")
	expect(entries.at(-1)).toMatchObject({ customType: PEERS_ENTRY, data: { label: "lead", namespace: "team" } })

	await peer.emit("session_shutdown", "resume")
	await peer.emit("session_start")
	expect(readPeer("alpha")).toMatchObject({ label: "lead", namespace: "team" })

	await call(peer, "peer_set", { label: null, namespace: null })
	expect(readPeer("alpha")).toMatchObject({ label: "named" })
	expect(readPeer("alpha")?.namespace).toBeUndefined()
})

test("spawn hand-over applies once and is written to the session file", async () => {
	const peer = createPeer("child", { label: "fixer", namespace: "babysit" })
	await peer.emit("session_start")
	expect(readPeer("child")).toMatchObject({ label: "fixer", namespace: "babysit" })

	await call(peer, "peer_set", { label: "renamed" })
	await peer.emit("session_shutdown", "reload")
	await peer.emit("session_start")
	expect(readPeer("child")).toMatchObject({ label: "renamed", namespace: "babysit" })
})

test("peer_spawn opens an unfocused Rex window and queues the prompt as a request", async () => {
	// Spawned peers start clean, like any session the user starts.
	registerChildPolicy(bus, () => ["--policy", "strict"])
	const spawner = await startPeer("spawner", { label: "babysit", namespace: "babysit" })

	const result = await details(spawner, "peer_spawn", { prompt: "fix CI", label: "fixer", cwd: "sub", model: "p/m" })

	expect(result).toMatchObject({ blockId: "block:1", windowId: "window:new", label: "fixer", namespace: "babysit" })
	const peerId = String(result.peerId)
	expect(rexCalls).toHaveLength(1)
	const [rexCall] = rexCalls
	expect(rexCall?.session).toBe("session:rex")
	expect(rexCall?.method).toBe("session.new_window")
	expect(rexCall?.args.focus).toBe(false)

	const block = z
		.object({
			block: z
				.object({
					flavor: z.literal("com.superlogical.terminal.shell"),
					label: z.literal("peer fixer"),
					// Only cwd and command: Rex picks the default login shell.
					options: z.object({ cwd: z.literal(join(root, "sub")), command: z.array(z.string()) }).strict(),
				})
				.strict(),
		})
		.strict()
		.parse(rexCall?.args.layout)

	const command = block.block.options.command
	expect(command.slice(0, 3)).toEqual(["env", "PI_PEERS_LABEL=fixer", "PI_PEERS_NAMESPACE=babysit"])
	expect(command.slice(-4)).toEqual(["--session-id", peerId, "--model", "p/m"])
	expect(command).not.toContain("--policy")
	expect(command[command.indexOf("--extension") + 1]).toEndWith(join("extensions", "peers", "index.ts"))
	expect(command).not.toContain("--shell")

	const queued = JSON.parse(readFileSync(join(inboxDir(peerId), inbox(peerId)[0]!), "utf8"))
	expect(queued).toMatchObject({ kind: "request", text: "fix CI", from: { peerId: "spawner", label: "babysit" } })

	// The new session picks up its prompt on its first poll.
	const child = createPeer(peerId, { label: "fixer", namespace: "babysit" })
	await child.emit("session_start")
	await tick()
	expect(child.sent[0]?.options).toEqual({ triggerTurn: true })
	expect(texts(child.sent[0])).toEqual(["fix CI"])
})

test("peer_spawn placement splits beside a block or a window, and cleans up on failure", async () => {
	const spawner = await startPeer("spawner")
	await call(spawner, "peer_spawn", { prompt: "a", placement: { splitBeside: "block:x", rexSession: "session:other" } })
	await call(spawner, "peer_spawn", { prompt: "b", placement: { window: "window:w" } })

	expect(rexCalls.map(({ session, method, args }) => ({ session, method, ...args, layout: undefined }))).toEqual([
		{
			session: "session:other",
			method: "session.new_split",
			anchor_block_id: "block:x",
			window_id: null,
			direction: "horizontal",
			side: "after",
			focus: false,
			layout: undefined,
		},
		{
			session: "session:rex",
			method: "session.new_split",
			anchor_block_id: null,
			window_id: "window:w",
			direction: "horizontal",
			side: "after",
			focus: false,
			layout: undefined,
		},
	])

	await expect(
		call(spawner, "peer_spawn", { prompt: "c", placement: { window: "new", splitBeside: "block:x" } }),
	).rejects.toThrow("cannot be combined")

	rexFailure = "Error: no such session"
	const before = readdirSync(join(root, "peers")).length
	await expect(call(spawner, "peer_spawn", { prompt: "d" })).rejects.toThrow("no such session")
	expect(readdirSync(join(root, "peers")).length).toBe(before)
})

test("the pi.events API exposes list, send, and spawn", async () => {
	// One pi process has one bus; keep the target off the caller's.
	const target = await startPeer("target", { label: "worker", events: createEventBus() })
	await startPeer("api")

	expect((await requestPeers(bus, "peers:list", {})).peers.map((peer) => peer.peerId)).toEqual(["target"])
	const sent = await requestPeers(bus, "peers:send", { to: "worker", text: "go", kind: "request" })
	expect(sent.to).toBe("target")
	await expect(requestPeers(bus, "peers:send", { to: "worker", text: "", kind: "note" })).rejects.toThrow(
		"Invalid peers:send parameters",
	)
	expect((await requestPeers(bus, "peers:spawn", { prompt: "x" })).blockId).toBe("block:1")
	expect(target.tools.size).toBe(4)
	await expect(requestPeers(createEventBus(), "peers:list", {})).rejects.toThrow("peers is not installed")
})

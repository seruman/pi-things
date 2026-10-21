import { resolve } from "node:path"
import { type JsonValue, uuidv7 } from "@earendil-works/pi-ai"
import type { AgentToolResult, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent"
import { z } from "zod"
import { type Exec, createRexClient } from "../rex/client"
import { type PeerOperations, offerMessage, registerPeersApi } from "./api"
import type { PeersContext, PeersHost } from "./contracts"
import { MESSAGE_TYPE, batchContent, renderMessage } from "./messages"
import {
	type Peer,
	type PeerMessage,
	discardSpawn,
	enqueue,
	listLivePeers,
	nameSchema,
	newMessageId,
	normalizeName,
	pendingMessages,
	readMessage,
	removeMessage,
	removeStale,
	unregister,
	writePeer,
} from "./registry"
import {
	type ListResult,
	type PeerInfo,
	type SendParameters,
	type SendResult,
	type SetParameters,
	type SetResult,
	type SpawnParameters,
	type SpawnResult,
	listParameters,
	listResultSchema,
	sendParameters,
	sendResultSchema,
	setParameters,
	setResultSchema,
	spawnParameters,
	spawnResultSchema,
} from "./schemas"
import { labelEnv, launchCommand, namespaceEnv, place } from "./spawn"

export const PEERS_ENTRY = "peers"

const POLL_MS = 250

const metadataSchema = z.object({ label: nameSchema.optional(), namespace: nameSchema.optional() })

type Metadata = z.infer<typeof metadataSchema>

interface Pending {
	path: string
	message: PeerMessage
}

type DeliveryOptions = NonNullable<Parameters<PeersHost["sendMessage"]>[1]>

interface Started {
	ctx: PeersContext
	peerId: string
}

export interface PeersEnvironment {
	rexSession?: string
	rexBlock?: string
	/** Label and namespace handed over by peer_spawn. Applied once, on the first session start. */
	label?: string
	namespace?: string
}

function toolResult<T extends JsonValue>(body: T, text: string): AgentToolResult<T> {
	return { content: [{ type: "text", text }], details: body, structuredContent: body }
}

function isPeersEntry(entry: SessionEntry): entry is SessionEntry & { type: "custom"; data?: unknown } {
	return entry.type === "custom" && entry.customType === PEERS_ENTRY
}

// Latest entry wins, so /resume restores what the session last set for itself.
function readMetadata(ctx: PeersContext): Metadata {
	const entry = ctx.sessionManager.getEntries().findLast(isPeersEntry)

	if (!entry) return {}
	const parsed = metadataSchema.safeParse(entry.data)

	if (!parsed.success) throw new Error(`Invalid peers entry in session: ${parsed.error.message}`)

	return parsed.data
}

function sameMetadata(a: Metadata, b: Metadata): boolean {
	return a.label === b.label && a.namespace === b.namespace
}

function info(peer: Peer): PeerInfo {
	const result: PeerInfo = { peerId: peer.peerId, state: peer.state, cwd: peer.cwd, rex: peer.rex }

	if (peer.label !== undefined) result.label = peer.label

	if (peer.namespace !== undefined) result.namespace = peer.namespace

	return result
}

function describe(peer: PeerInfo): string {
	const parts = [peer.label ? `${peer.label} (${peer.peerId})` : peer.peerId, peer.state, peer.cwd]

	if (peer.rex) parts.push(`rex ${peer.rex.blockId}`)

	return parts.join("  ")
}

export default function (pi: ExtensionAPI) {
	// Subagent children belong to their parent; they are never peers.
	if (process.env.PI_SUBAGENT_RUN_DIR) return

	const environment: PeersEnvironment = {
		rexSession: process.env.REX_SESSION,
		rexBlock: process.env.REX_BLOCK,
		label: process.env[labelEnv],
		namespace: process.env[namespaceEnv],
	}

	// Commands this session runs, including pi sessions it starts, must not inherit them.
	delete process.env[labelEnv]
	delete process.env[namespaceEnv]

	installPeers(pi, environment)
}

export function installPeers(pi: PeersHost, environment: PeersEnvironment): void {
	const exec: Exec = (command, args, signal) => pi.exec(command, args, signal ? { signal } : {})
	const rex = createRexClient(exec)
	let current: PeersContext | undefined
	let peerId: string | undefined
	let metadata: Metadata = {}
	let spawnApplied = false
	let busy = false
	// A turn was requested but agent_start has not fired yet.
	let triggered = false
	let published: string | undefined
	let timer: ReturnType<typeof setInterval> | undefined
	let draining = false

	const started = (): Started => {
		if (!current || !peerId) throw new Error("peers is not started for this session")

		return { ctx: current, peerId }
	}

	const label = (): string | undefined => {
		if (metadata.label !== undefined) return metadata.label
		const name = pi.getSessionName()?.trim().slice(0, 64)
		const parsed = name ? nameSchema.safeParse(name.trim()) : undefined

		return parsed?.success ? parsed.data : undefined
	}

	const self = (): Peer => {
		const { ctx, peerId: id } = started()

		const peer: Peer = {
			peerId: id,
			sessionFile: ctx.sessionManager.getSessionFile() ?? null,
			cwd: ctx.cwd,
			pid: process.pid,
			rex:
				environment.rexSession && environment.rexBlock
					? { sessionId: environment.rexSession, blockId: environment.rexBlock }
					: null,
			state: busy || triggered ? "busy" : "idle",
			updatedAt: new Date().toISOString(),
		}

		const currentLabel = label()

		if (currentLabel !== undefined) peer.label = currentLabel

		if (metadata.namespace !== undefined) peer.namespace = metadata.namespace

		return peer
	}

	// Rewrites peer.json only when something other than the timestamp changed.
	const publish = (): void => {
		if (!current || !peerId) return
		const peer = self()
		const key = JSON.stringify({ ...peer, updatedAt: undefined })

		if (key === published) return
		writePeer(peer)
		published = key
	}

	const visible = (): Peer[] =>
		listLivePeers().filter((peer) => peer.peerId !== peerId && peer.namespace === metadata.namespace)

	const resolveTarget = (to: string): Peer => {
		if (to === peerId || to === environment.rexBlock) throw new Error("A session cannot message itself")
		const peers = visible()
		const byId = peers.find((peer) => peer.peerId === to || peer.rex?.blockId === to)

		if (byId) return byId
		const byLabel = peers.filter((peer) => peer.label === to)

		if (byLabel.length === 1) return byLabel[0]!

		if (byLabel.length > 1) {
			throw new Error(`Label "${to}" matches several peers: ${byLabel.map((peer) => peer.peerId).join(", ")}`)
		}

		throw new Error(`No live peer "${to}" in this session's namespace`)
	}

	const from = (): PeerMessage["from"] => {
		const peer = self()
		const sender: PeerMessage["from"] = { peerId: peer.peerId }

		if (peer.label !== undefined) sender.label = peer.label

		if (peer.namespace !== undefined) sender.namespace = peer.namespace

		return sender
	}

	const message = (kind: PeerMessage["kind"], text: string, options: { steer?: boolean; replyTo?: string }) => {
		const result: PeerMessage = {
			id: newMessageId(),
			kind,
			steer: options.steer ?? false,
			from: from(),
			text,
			sentAt: new Date().toISOString(),
		}

		if (options.replyTo !== undefined) result.replyTo = options.replyTo

		return result
	}

	const list = (): ListResult => ({ self: info(self()), peers: visible().map(info) })

	const send = (params: SendParameters): SendResult => {
		started()

		if (params.steer && params.kind !== "request") throw new Error("steer only applies to requests")
		const target = resolveTarget(params.to)
		const outgoing = message(params.kind, params.text, params)
		enqueue(target.peerId, outgoing)

		return { messageId: outgoing.id, to: target.peerId }
	}

	const spawn = async (params: SpawnParameters, signal?: AbortSignal): Promise<SpawnResult> => {
		const { ctx } = started()
		const rexSession = params.placement?.rexSession ?? environment.rexSession

		if (!rexSession) throw new Error("Not running in Rex: set placement.rexSession")
		const newLabel = params.label === undefined ? undefined : normalizeName(params.label)

		const namespace =
			params.namespace === undefined
				? metadata.namespace
				: params.namespace === null
					? undefined
					: normalizeName(params.namespace)

		// Same generator pi uses for session ids (createSessionId).
		const id = uuidv7()

		const command = launchCommand({
			peerId: id,
			label: newLabel,
			namespace,
			model: params.model,
			thinkingLevel: params.thinkingLevel,
		})

		// Queue the prompt before launch so the new peer finds it on its first poll.
		enqueue(id, message("request", params.prompt, {}))

		let placed: { blockId: string; windowId?: string }

		try {
			placed = await place(
				rex,
				rexSession,
				params.placement,
				{ label: `peer ${newLabel ?? id.slice(0, 8)}`, cwd: resolve(ctx.cwd, params.cwd ?? "."), command },
				signal,
			)
		} catch (error) {
			discardSpawn(id)
			throw error
		}

		const result: SpawnResult = { peerId: id, blockId: placed.blockId }

		if (placed.windowId !== undefined) result.windowId = placed.windowId

		if (newLabel !== undefined) result.label = newLabel

		if (namespace !== undefined) result.namespace = namespace

		return result
	}

	const set = (params: SetParameters): SetResult => {
		const { peerId: id } = started()

		if (params.label === undefined && params.namespace === undefined) throw new Error("Set label or namespace")
		const next: Metadata = { ...metadata }

		if (params.label === null) delete next.label
		else if (params.label !== undefined) next.label = normalizeName(params.label)

		if (params.namespace === null) delete next.namespace
		else if (params.namespace !== undefined) next.namespace = normalizeName(params.namespace)

		if (!sameMetadata(next, metadata)) pi.appendEntry(PEERS_ENTRY, next)
		metadata = next
		publish()
		const result: SetResult = { peerId: id }
		const currentLabel = label()

		if (currentLabel !== undefined) result.label = currentLabel

		if (metadata.namespace !== undefined) result.namespace = metadata.namespace

		return result
	}

	const report = (ctx: PeersContext, text: string): void => {
		if (ctx.hasUI) ctx.ui.notify(text, "error")
		else console.error(text)
	}

	// Inbox files already offered on peers:message and not claimed, so listeners see each message once.
	const offered = new Set<string>()

	// Reads the inbox in send order. Extensions claim messages here, whatever the session is doing.
	const readPending = (ctx: PeersContext, id: string): Pending[] => {
		const pending: Pending[] = []

		for (const path of pendingMessages(id)) {
			let incoming: PeerMessage

			try {
				incoming = readMessage(path)
			} catch (error) {
				removeMessage(path)
				report(ctx, `Dropped unreadable peer message ${path}: ${error instanceof Error ? error.message : error}`)
				continue
			}

			if (!offered.has(path)) {
				offered.add(path)

				if (offerMessage(pi.events, incoming)) {
					removeMessage(path)
					offered.delete(path)
					continue
				}
			}

			pending.push({ path, message: incoming })
		}

		return pending
	}

	// One custom message for the whole batch. Files go only after sendMessage returns.
	const deliver = (batch: Pending[], options: DeliveryOptions): void => {
		const messages = batch.map((item) => item.message)
		pi.sendMessage(
			{ customType: MESSAGE_TYPE, content: batchContent(messages), display: true, details: { messages } },
			options,
		)

		for (const item of batch) {
			removeMessage(item.path)
			offered.delete(item.path)
		}
	}

	const isSteer = (item: Pending): boolean => item.message.kind === "request" && item.message.steer

	const drain = (): void => {
		if (draining || !current || !peerId) return
		const ctx = current
		draining = true

		try {
			const pending = readPending(ctx, peerId)

			// A requested turn has not started yet: everything waits for the next batch.
			if (pending.length === 0 || triggered) return

			if (busy || !ctx.isIdle()) {
				// Only steers interrupt a running turn. Everything else waits until it settles,
				// so several requests become one turn rather than one follow-up turn each.
				const steers = pending.filter(isSteer)

				// triggerTurn still starts a turn if the agent went idle since the check.
				if (steers.length > 0) deliver(steers, { triggerTurn: true, deliverAs: "steer" })

				return
			}

			if (!pending.some((item) => item.message.kind === "request")) {
				deliver(pending, { deliverAs: "nextTurn" })

				return
			}

			// Set first: pi may start the turn, and fire agent_start, before sendMessage returns.
			triggered = true

			try {
				deliver(pending, { triggerTurn: true })
			} catch (error) {
				triggered = false
				throw error
			}
		} finally {
			draining = false
		}
	}

	const tick = (): void => {
		try {
			publish()
			drain()
			// Show a triggered turn as busy right away, so senders do not see a stale idle.
			publish()
		} catch (error) {
			if (current) report(current, `peers: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	pi.registerMessageRenderer(MESSAGE_TYPE, renderMessage)

	pi.on("session_start", (_event, ctx) => {
		current = ctx
		peerId = ctx.sessionManager.getSessionId()
		published = undefined
		busy = !ctx.isIdle()
		triggered = false
		removeStale()
		metadata = readMetadata(ctx)

		if (!spawnApplied) {
			spawnApplied = true
			const handedOver: Metadata = { ...metadata }

			if (environment.label !== undefined) handedOver.label = normalizeName(environment.label)

			if (environment.namespace !== undefined) handedOver.namespace = normalizeName(environment.namespace)

			if (!sameMetadata(handedOver, metadata)) {
				pi.appendEntry(PEERS_ENTRY, handedOver)
				metadata = handedOver
			}
		}

		publish()

		if (timer) clearInterval(timer)
		timer = setInterval(tick, POLL_MS)
		timer.unref()
	})

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer)
		timer = undefined

		if (peerId) unregister(peerId)
		current = undefined
		peerId = undefined
		published = undefined
	})

	pi.on("agent_start", () => {
		busy = true
		triggered = false
		tick()
	})

	pi.on("agent_settled", () => {
		busy = false
		triggered = false
		tick()
	})

	const operations: PeerOperations = { list, send, spawn: (params) => spawn(params) }
	registerPeersApi(pi.events, operations)

	pi.registerTool({
		name: "peer_list",
		label: "List peers",
		description:
			"List live pi sessions this session can message: those in the same namespace (the open pool counts as one).",
		parameters: listParameters,
		outputSchema: listResultSchema,
		async execute() {
			const result = list()
			const lines = result.peers.map(describe)

			return toolResult(result, lines.length > 0 ? lines.join("\n") : "No other peers")
		},
	})

	pi.registerTool({
		name: "peer_send",
		label: "Send to peer",
		description:
			"Send a message to another pi session. A request wakes it (queued after its current turn unless steer). A note reaches it on its next turn and never starts one. Returns the message id.",
		promptGuidelines: [
			"When answering a peer message, use peer_send with replyTo set to its message id.",
			'Reply with kind "note" unless the other side has to act on your answer. Never send acknowledgements as "request".',
			"There is no wait: answers arrive later as peer messages.",
		],
		parameters: sendParameters,
		outputSchema: sendResultSchema,
		async execute(_id, params) {
			const result = send(params)

			return toolResult(result, `Sent ${params.kind} ${result.messageId} to ${result.to}`)
		},
	})

	pi.registerTool({
		name: "peer_spawn",
		label: "Spawn peer",
		description:
			"Start a new pi session as a peer in Rex and send it the prompt as a request from this session. By default it opens in a new, unfocused window of this Rex session. Returns its peer id and Rex block id.",
		parameters: spawnParameters,
		outputSchema: spawnResultSchema,
		async execute(_id, params, signal) {
			const result = await spawn(params, signal)

			return toolResult(result, `Spawned peer ${result.label ?? result.peerId} in ${result.blockId}`)
		},
	})

	pi.registerTool({
		name: "peer_set",
		label: "Set peer identity",
		description:
			"Change this session's own peer label or namespace. Changing namespace changes which peers it can see and reach.",
		parameters: setParameters,
		outputSchema: setResultSchema,
		async execute(_id, params) {
			const result = set(params)

			return toolResult(
				result,
				`Peer ${result.label ?? result.peerId} in ${result.namespace ? `namespace ${result.namespace}` : "the open pool"}`,
			)
		},
	})
}

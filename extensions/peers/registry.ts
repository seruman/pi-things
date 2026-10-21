import { randomBytes } from "node:crypto"
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { z } from "zod"

// Same rule as pi session ids, so a peer id is always a safe directory name.
const peerIdSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/, "Invalid peer id")

// Labels and namespaces show up in prompts and terminal titles.
export const nameSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^\S(?:[\s\S]*\S)?$/, "Peer names must not have surrounding whitespace")
	// oxlint-disable-next-line no-control-regex -- Reject terminal control characters.
	.regex(/^[^\u0000-\u001f\u007f]*$/, "Peer names must not contain control characters")

export function normalizeName(value: string): string {
	return nameSchema.parse(value.trim())
}

const peerSchema = z.object({
	peerId: peerIdSchema,
	sessionFile: z.string().nullable(),
	cwd: z.string(),
	label: nameSchema.optional(),
	namespace: nameSchema.optional(),
	pid: z.number().int(),
	rex: z.object({ sessionId: z.string(), blockId: z.string() }).nullable(),
	state: z.enum(["idle", "busy"]),
	updatedAt: z.string(),
})

export type Peer = z.infer<typeof peerSchema>

export const messageSchema = z.object({
	id: z.string(),
	kind: z.enum(["request", "note"]),
	steer: z.boolean(),
	from: z.object({ peerId: peerIdSchema, label: nameSchema.optional(), namespace: nameSchema.optional() }),
	replyTo: z.string().optional(),
	text: z.string(),
	sentAt: z.string(),
})

export type PeerMessage = z.infer<typeof messageSchema>

export function peersDir(): string {
	return join(getAgentDir(), "peers")
}

export function peerDir(peerId: string): string {
	return join(peersDir(), peerIdSchema.parse(peerId))
}

export function inboxDir(peerId: string): string {
	return join(peerDir(peerId), "inbox")
}

function peerFile(peerId: string): string {
	return join(peerDir(peerId), "peer.json")
}

function writeAtomic(target: string, value: Peer | PeerMessage): void {
	const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
	renameSync(temporary, target)
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)

		return true
	} catch (error) {
		// EPERM still means the process exists, it is just owned by someone else.
		return error instanceof Error && "code" in error && error.code === "EPERM"
	}
}

export function writePeer(peer: Peer): void {
	mkdirSync(inboxDir(peer.peerId), { recursive: true, mode: 0o700 })
	writeAtomic(peerFile(peer.peerId), peerSchema.parse(peer))
}

// Readers skip unreadable records: another pi-things version or a half-removed directory
// must not break discovery for everyone else.
export function readPeer(peerId: string): Peer | undefined {
	try {
		return peerSchema.parse(JSON.parse(readFileSync(peerFile(peerId), "utf8")))
	} catch {
		return undefined
	}
}

function peerIds(): string[] {
	if (!existsSync(peersDir())) return []

	return readdirSync(peersDir()).filter((name) => peerIdSchema.safeParse(name).success)
}

export function listLivePeers(): Peer[] {
	return peerIds()
		.map(readPeer)
		.filter((peer): peer is Peer => peer !== undefined && isAlive(peer.pid))
}

function removeIfEmpty(peerId: string): void {
	const inbox = inboxDir(peerId)

	// Keep undelivered messages: the session gets them when it resumes.
	if (existsSync(inbox) && readdirSync(inbox).some((name) => name.endsWith(".json"))) return
	rmSync(peerDir(peerId), { recursive: true, force: true })
}

/** Removes this peer's live record. Pending inbox messages stay for the next resume. */
export function unregister(peerId: string): void {
	rmSync(peerFile(peerId), { force: true })
	removeIfEmpty(peerId)
}

/** Undelivered messages for sessions that never resume are dropped after this long. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function modifiedAt(path: string): number | undefined {
	// Files can vanish while we look: their owner may be delivering or shutting down.
	return statSync(path, { throwIfNoEntry: false })?.mtimeMs
}

// Newest inbox message, else peer.json, else the directory itself.
function lastActivity(peerId: string): number | undefined {
	const messages = pendingMessages(peerId).map(modifiedAt)
	const newest = Math.max(...messages.filter((time) => time !== undefined))

	if (Number.isFinite(newest)) return newest

	return modifiedAt(peerFile(peerId)) ?? modifiedAt(peerDir(peerId))
}

/**
 * Drops records of peers whose process is gone, keeping their undelivered messages.
 * Directories of dead peers, and spawns that never started, go once their last activity is older than MAX_AGE_MS.
 */
export function removeStale(now = Date.now()): void {
	for (const peerId of peerIds()) {
		const peer = readPeer(peerId)

		if (peer && isAlive(peer.pid)) continue
		const activity = lastActivity(peerId)

		if (peer) unregister(peerId)

		if (activity !== undefined && now - activity > MAX_AGE_MS) {
			rmSync(peerDir(peerId), { recursive: true, force: true })
		}
	}
}

let lastMs = 0

let sequence = 0

export function newMessageId(): string {
	const now = Date.now()
	sequence = now === lastMs ? sequence + 1 : 0
	lastMs = now

	// Zero-padded time and sequence keep file names in send order from one sender.
	return `${now.toString().padStart(15, "0")}-${sequence.toString().padStart(4, "0")}-${randomBytes(4).toString("hex")}`
}

export function enqueue(peerId: string, message: PeerMessage): void {
	const directory = inboxDir(peerId)
	mkdirSync(directory, { recursive: true, mode: 0o700 })
	writeAtomic(join(directory, `${message.id}.json`), messageSchema.parse(message))
}

export function pendingMessages(peerId: string): string[] {
	const directory = inboxDir(peerId)

	if (!existsSync(directory)) return []

	return readdirSync(directory)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => join(directory, name))
}

export function readMessage(path: string): PeerMessage {
	return messageSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

export function removeMessage(path: string): void {
	unlinkSync(path)
}

/** Removes a directory created for a spawn that never started. */
export function discardSpawn(peerId: string): void {
	const directory = peerDir(peerId)

	if (existsSync(join(directory, "peer.json"))) return
	rmSync(directory, { recursive: true, force: true })
}

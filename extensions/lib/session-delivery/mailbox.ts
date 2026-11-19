import { randomUUID } from "node:crypto"
import {
	constants,
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { z } from "zod"

import {
	instanceIdSchema,
	membershipGenerationSchema,
	messageIdSchema,
	relationIdSchema,
	runHandleSchema,
	sessionIdSchema,
	type InstanceId,
	type SessionId,
} from "./identity"

const id = z.string().min(1).max(160).pipe(sessionIdSchema)

const handle = z.string().min(1).max(160).pipe(runHandleSchema)

const instanceId = instanceIdSchema

const address = z
	.object({ sessionId: id, instanceId, name: z.string().max(256).optional() })
	.strict()
	.readonly()

export const deliverySchema = z.enum(["steer", "followUp", "passive"])

export const poolNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/)

const membershipSchema = z.object({ pool: poolNameSchema, generation: membershipGenerationSchema }).strict().readonly()

const poolRoute = z
	.object({
		kind: z.literal("pool"),
		pool: poolNameSchema,
		senderGeneration: membershipGenerationSchema,
		recipientGeneration: membershipGenerationSchema,
	})
	.strict()

const familyRoute = z
	.object({ kind: z.literal("family"), relation: relationIdSchema, handle, direction: z.enum(["delegate", "reply"]) })
	.strict()

const completionRoute = z
	.object({ kind: z.literal("completion"), relation: relationIdSchema, handle, sequence: z.number().int().positive() })
	.strict()

const routeSchema = z.discriminatedUnion("kind", [poolRoute, familyRoute, completionRoute]).readonly()

export type FamilyRoute = Extract<z.infer<typeof routeSchema>, { kind: "family" }>

export type FamilyPolicy = (route: FamilyRoute, from: Endpoint, to: Endpoint) => boolean

const messageFields = {
	to: address,
	text: z
		.string()
		.min(1)
		.max(16384)
		.refine((text) => Buffer.byteLength(text) <= 16384, "Message exceeds 16 KiB"),
	delivery: deliverySchema,
	createdAt: z.number().int().nonnegative(),
}

export const messageSchema = z.union([
	z
		.object({
			version: z.literal(2),
			route: z.discriminatedUnion("kind", [poolRoute, familyRoute]).readonly(),
			id: messageIdSchema,
			from: address,
			...messageFields,
		})
		.strict()
		.readonly(),
	z
		.object({
			version: z.literal(2),
			route: completionRoute.readonly(),
			id: messageIdSchema,
			from: z
				.object({ sessionId: id, instanceId: relationIdSchema, name: z.string().max(256).optional() })
				.strict()
				.readonly(),
			...messageFields,
		})
		.strict()
		.readonly(),
])

export type Message = z.infer<typeof messageSchema>

const endpointSchema = z
	.object({
		sessionId: id,
		instanceId,
		pid: z.number().int().positive(),
		cwd: z.string().max(4096),
		name: z.string().max(256).optional(),
		sessionFile: z.string().max(4096).optional(),
		updatedAt: z.number(),
		ready: z.boolean(),
		membership: membershipSchema.optional(),
	})
	.strict()
	.readonly()

export type Endpoint = z.infer<typeof endpointSchema>

export const admissionSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("queued") }),
	z.object({ kind: z.literal("submitted") }),
	z.object({ kind: z.literal("settled") }),
	z.object({ kind: z.literal("interrupted"), reason: z.string() }),
])

export type Admission = z.infer<typeof admissionSchema>

const stateSchema = z.object({ admissions: z.record(admissionSchema), interruption: z.string().optional() })

type State = z.infer<typeof stateSchema>

export const MAX_INBOX = 128

const MAX_FILE = 128 * 1024

const FRESH_MS = 15000

// Peers only need an endpoint fresher than FRESH_MS; refreshing it on every poll is wasted disk writes.
const HEARTBEAT_MS = 5000

export function mailboxRoot() {
	return join(getAgentDir(), "session-messages")
}

function readJson<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)

	try {
		const stat = fstatSync(fd)

		if (!stat.isFile() || stat.size > MAX_FILE) throw new Error("Message file is too large or not a regular file")

		return schema.parse(JSON.parse(readFileSync(fd, "utf8")))
	} finally {
		closeSync(fd)
	}
}

function atomic(path: string, value: Message | Endpoint | State) {
	const temp = `${path}.${randomUUID()}.tmp`

	try {
		writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" })
		renameSync(temp, path)
	} finally {
		if (existsSync(temp)) unlinkSync(temp)
	}
}

function alive(endpoint: Endpoint) {
	if (!endpoint.ready || Math.abs(Date.now() - endpoint.updatedAt) > FRESH_MS) return false

	try {
		process.kill(endpoint.pid, 0)

		return true
	} catch {
		return false
	}
}

function directories(root: string) {
	return existsSync(root)
		? readdirSync(root, { withFileTypes: true })
				.filter((e) => e.isDirectory() && instanceId.safeParse(e.name).success)
				.map((e) => e.name)
		: []
}

export function listEndpoints(root = mailboxRoot()): Endpoint[] {
	return directories(root).flatMap((name) => {
		try {
			const endpoint = readJson(join(root, name, "endpoint.json"), endpointSchema)

			return endpoint.instanceId === name && alive(endpoint) ? [endpoint] : []
		} catch {
			return []
		}
	})
}

export type WorkStatus =
	| { kind: "unavailable" }
	| { kind: "pending" | "idle"; instanceId: InstanceId }
	| { kind: "interrupted"; origin: "observer"; instanceId?: InstanceId; reason: string }
	| { kind: "interrupted"; origin: "delivery"; instanceId: InstanceId; reason: string }

export function workStatus(
	target: { sessionId?: SessionId; sessionFile?: string; instanceId?: InstanceId },
	root = mailboxRoot(),
	familyPolicy?: FamilyPolicy,
): WorkStatus {
	const matches = listEndpoints(root).filter((e) =>
		target.sessionId ? e.sessionId === target.sessionId : e.sessionFile === target.sessionFile,
	)

	const endpoint = matches[0]

	if (!endpoint) {
		return target.instanceId
			? { kind: "interrupted", origin: "observer", reason: "Messaging receiver disappeared" }
			: { kind: "unavailable" }
	}

	if (matches.length !== 1 || (target.instanceId && endpoint.instanceId !== target.instanceId)) {
		return { kind: "interrupted", origin: "observer", reason: "Messaging receiver replaced or ambiguous" }
	}

	const directory = join(root, endpoint.instanceId)

	try {
		const state = readJson(join(directory, "state.json"), stateSchema)

		const messages = readdirSync(join(directory, "inbox"))
			.filter((n) => n.endsWith(".json"))
			.flatMap((n) => {
				try {
					const message = readJson(join(directory, "inbox", n), messageSchema)

					const submitted =
						state.admissions[message.id]?.kind === "submitted" &&
						message.to.instanceId === endpoint.instanceId &&
						message.to.sessionId === endpoint.sessionId

					return submitted || authorized(message, endpoint, root, familyPolicy) ? [message] : []
				} catch {
					return []
				}
			})

		const pending = messages.some(
			(m) => m.delivery !== "passive" && !["settled", "interrupted"].includes(state.admissions[m.id]?.kind ?? "queued"),
		)

		if (pending) return { kind: "pending", instanceId: endpoint.instanceId }

		return state.interruption
			? { kind: "interrupted", origin: "delivery", instanceId: endpoint.instanceId, reason: state.interruption }
			: { kind: "idle", instanceId: endpoint.instanceId }
	} catch {
		return {
			kind: "interrupted",
			origin: "observer",
			instanceId: endpoint.instanceId,
			reason: "Messaging work state is unreadable",
		}
	}
}

function authorized(message: Message, recipient: Endpoint, root: string, familyPolicy?: FamilyPolicy): boolean {
	if (message.to.sessionId !== recipient.sessionId || message.to.instanceId !== recipient.instanceId) return false

	if (message.route.kind === "completion") return false
	const endpoints = listEndpoints(root)
	const recipients = endpoints.filter((e) => e.sessionId === recipient.sessionId)

	if (recipients.length !== 1 || recipients[0]?.instanceId !== recipient.instanceId) return false
	const senders = endpoints.filter((e) => e.sessionId === message.from.sessionId)
	const sender = senders[0]

	if (senders.length !== 1 || !sender || sender.instanceId !== message.from.instanceId) return false
	const route = message.route

	if (route.kind === "family") return familyPolicy?.(route, sender, recipient) === true

	return (
		sender.membership?.pool === route.pool &&
		recipient.membership?.pool === route.pool &&
		sender.membership.generation === route.senderGeneration &&
		recipient.membership.generation === route.recipientGeneration
	)
}

export class SessionMailbox {
	private registration: Endpoint
	get endpoint() {
		return this.registration
	}
	private readonly directory: string
	private state: State = { admissions: {} }
	private savedState = JSON.stringify(this.state)
	private lastCreatedAt = 0
	private closed = false
	constructor(
		identity: Pick<Endpoint, "sessionId" | "cwd" | "name" | "sessionFile">,
		readonly root = mailboxRoot(),
		private readonly familyPolicy?: FamilyPolicy,
	) {
		this.registration = endpointSchema.parse({
			...identity,
			instanceId: randomUUID(),
			pid: process.pid,
			updatedAt: Date.now(),
			ready: true,
		})
		this.directory = join(root, this.endpoint.instanceId)
		mkdirSync(join(this.directory, "inbox"), { recursive: true, mode: 0o700 })
		atomic(join(this.directory, "state.json"), this.state)
		this.heartbeat(identity.name)

		for (const name of directories(root)) {
			try {
				const old = readJson(join(root, name, "endpoint.json"), endpointSchema)

				if (Date.now() - old.updatedAt < 86400000) continue

				try {
					process.kill(old.pid, 0)
					continue
				} catch {}

				rmSync(join(root, name), { recursive: true, force: true })
			} catch {}
		}
	}
	// The periodic form of heartbeat: publishes only a changed name or an ageing endpoint.
	keepAlive(name: string | undefined) {
		if (name === this.endpoint.name && Math.abs(Date.now() - this.endpoint.updatedAt) < HEARTBEAT_MS) return
		this.heartbeat(name)
	}
	heartbeat(name: string | undefined) {
		if (this.closed) return
		const next = endpointSchema.parse({ ...this.endpoint, name, updatedAt: Date.now() })
		atomic(join(this.directory, "endpoint.json"), next)
		this.registration = next
	}
	join(pool: string) {
		if (this.closed) throw new Error("Messaging instance retired")
		poolNameSchema.parse(pool)

		if (this.endpoint.membership?.pool === pool) return
		this.registration = endpointSchema.parse({ ...this.endpoint, membership: { pool, generation: randomUUID() } })
		this.heartbeat(this.endpoint.name)
	}
	leave() {
		this.registration = endpointSchema.parse({ ...this.endpoint, membership: undefined })
		this.heartbeat(this.endpoint.name)
	}
	peers() {
		const pool = this.endpoint.membership?.pool

		return pool ? listEndpoints(this.root).filter((e) => e.membership?.pool === pool) : []
	}
	authorized(message: Message) {
		return authorized(message, this.endpoint, this.root, this.familyPolicy)
	}
	send(to: SessionId, text: string, delivery: Message["delivery"] = "steer", family?: FamilyRoute): Message {
		if (this.closed) throw new Error("Messaging instance retired")

		if (!family && !this.endpoint.membership) throw new Error("Join a shared pool before sending")

		if (to === this.endpoint.sessionId) throw new Error("Self-send is not allowed")
		const matches = listEndpoints(this.root).filter((e) => e.sessionId === to)

		const recipient = matches[0]

		if (!recipient) throw new Error(`Offline or unknown session ID ${to}`)

		if (matches.length > 1) throw new Error(`Ambiguous session ID ${to}`)

		if (!family && (!recipient.membership || recipient.membership.pool !== this.endpoint.membership?.pool)) {
			throw new Error("Recipient is not a member of the shared pool")
		}

		const directory = join(this.root, recipient.instanceId, "inbox")

		if (readdirSync(directory).length >= MAX_INBOX) throw new Error("Recipient inbox is full; retry later")
		this.lastCreatedAt = Math.max(Date.now(), this.lastCreatedAt + 1)

		const message = messageSchema.parse({
			version: 2,
			route: family ?? {
				kind: "pool",
				pool: this.endpoint.membership?.pool,
				senderGeneration: this.endpoint.membership?.generation,
				recipientGeneration: recipient.membership?.generation,
			},
			id: randomUUID(),
			from: { sessionId: this.endpoint.sessionId, instanceId: this.endpoint.instanceId, name: this.endpoint.name },
			to: { sessionId: to, instanceId: recipient.instanceId, name: recipient.name },
			text,
			delivery,
			createdAt: this.lastCreatedAt,
		})

		if (!authorized(message, recipient, this.root, this.familyPolicy)) {
			throw new Error("Message route is not authorized")
		}

		atomic(join(directory, `${String(message.createdAt).padStart(16, "0")}-${message.id}.json`), message)

		return message
	}
	receive(report: (error: string) => void): Message[] {
		if (this.closed) return []
		const result: Message[] = []

		for (const name of readdirSync(join(this.directory, "inbox"))
			.filter((n) => n.endsWith(".json"))
			.sort()
			.slice(0, MAX_INBOX)) {
			const path = join(this.directory, "inbox", name)

			try {
				const message = readJson(path, messageSchema)

				if (message.to.sessionId !== this.endpoint.sessionId || message.to.instanceId !== this.endpoint.instanceId) {
					throw new Error("Wrong recipient instance")
				}

				if (name !== `${String(message.createdAt).padStart(16, "0")}-${message.id}.json`) {
					throw new Error("Envelope filename does not match its identity")
				}

				if (this.state.admissions[message.id]) continue

				if (!this.authorized(message)) {
					report(`Rejected unauthorized mailbox file ${name}`)
					unlinkSync(path)
					continue
				}

				this.state.admissions[message.id] = { kind: "queued" }
				result.push(message)
			} catch (error) {
				const reason = `Rejected mailbox file ${name}: ${String(error).slice(0, 512)}`
				report(reason)
				unlinkSync(path)
			}
		}

		this.save()

		return result
	}
	withdraw(message: Message) {
		delete this.state.admissions[message.id]
		this.save()
		const path = join(this.directory, "inbox", `${String(message.createdAt).padStart(16, "0")}-${message.id}.json`)

		if (existsSync(path)) unlinkSync(path)
	}
	transition(message: Message, admission: Admission) {
		if (this.closed) return
		this.state.admissions[message.id] = admission

		if (message.delivery !== "passive") {
			if (admission.kind === "interrupted") this.state.interruption = `${message.id}: ${admission.reason}`

			if (admission.kind === "settled") delete this.state.interruption
		}

		this.save()

		if (admission.kind === "settled" || admission.kind === "interrupted") {
			const path = join(this.directory, "inbox", `${String(message.createdAt).padStart(16, "0")}-${message.id}.json`)

			if (existsSync(path)) unlinkSync(path)
		}
	}
	private save() {
		const terminal = Object.entries(this.state.admissions).filter(
			([, a]) => a.kind === "settled" || a.kind === "interrupted",
		)

		for (const [id] of terminal.slice(0, Math.max(0, terminal.length - MAX_INBOX))) delete this.state.admissions[id]
		const serialized = JSON.stringify(this.state)

		if (serialized === this.savedState) return

		try {
			atomic(join(this.directory, "state.json"), this.state)
			this.savedState = serialized
		} catch (error) {
			this.state = stateSchema.parse(JSON.parse(this.savedState))
			throw error
		}
	}
	recover() {
		if (this.closed || !this.state.interruption) return
		delete this.state.interruption
		this.save()
	}

	dispose() {
		if (this.closed) return
		this.closed = true
		atomic(join(this.directory, "endpoint.json"), { ...this.endpoint, ready: false, updatedAt: Date.now() })
	}
}

import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { z } from "zod"
import {
	relationIdSchema,
	runHandleSchema,
	sessionIdSchema,
	type RelationId,
	type RunHandle,
} from "../lib/session-delivery/identity"
import type { DeliveryService } from "../lib/session-delivery/runtime"
import type { ParentContext, ParentHost } from "./contracts"
import { listRuns, readMetadata, runDirectory, type RunMetadata } from "./runs"

const responseSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("response"), entryId: z.string().min(1) }).strict(),
	z.object({ kind: z.literal("none") }).strict(),
])

export const completionSchema = z
	.object({
		relation: relationIdSchema,
		handle: z.string().min(1).pipe(runHandleSchema),
		parentSessionId: z.string().min(1).pipe(sessionIdSchema),
		sequence: z.number().int().positive(),
		outcome: z.enum(["success", "error", "aborted"]),
		childSessionId: z.string().min(1).pipe(sessionIdSchema),
		sessionFile: z.string().min(1),
		response: responseSchema,
	})
	.strict()
	.readonly()

export type Completion = z.infer<typeof completionSchema>

export type CompletionSnapshot = Omit<Completion, "relation" | "handle" | "parentSessionId" | "sequence">

export function readCompletion(
	run: Pick<RunMetadata, "handle" | "relation" | "parentSessionId">,
): Completion | undefined {
	try {
		const fact = completionSchema.parse(
			JSON.parse(readFileSync(join(runDirectory(run.handle, run.parentSessionId), "completion.json"), "utf8")),
		)

		return fact.relation === run.relation && fact.parentSessionId === run.parentSessionId && fact.handle === run.handle
			? fact
			: undefined
	} catch {
		return undefined
	}
}

export function publishCompletion(
	run: Pick<RunMetadata, "handle" | "relation" | "parentSessionId">,
	snapshot: CompletionSnapshot,
) {
	if (!run.relation) return

	const fact = completionSchema.parse({
		...snapshot,
		relation: run.relation,
		handle: run.handle,
		parentSessionId: run.parentSessionId,
		sequence: (readCompletion(run)?.sequence ?? 0) + 1,
	})

	const target = join(runDirectory(run.handle, run.parentSessionId), "completion.json")
	const temporary = `${target}.${randomUUID()}.tmp`
	writeFileSync(temporary, JSON.stringify(fact), { mode: 0o600, flag: "wx" })
	renameSync(temporary, target)
}

export function completionAnswer(fact: Completion) {
	if (!existsSync(fact.sessionFile)) throw new Error(`Completion source is missing: ${fact.sessionFile}`)
	const session = SessionManager.open(fact.sessionFile)

	if (fact.response.kind === "none") return { session, answer: "" }
	const entry = session.getEntry(fact.response.entryId)

	if (
		session.getSessionId() !== fact.childSessionId ||
		entry?.type !== "message" ||
		entry.message.role !== "assistant"
	) {
		throw new Error(`Completion response identity is unavailable: ${fact.sessionFile} entry ${fact.response.entryId}`)
	}

	const answer = entry.message.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim()

	return { session, answer: answer || entry.message.errorMessage || "(no response text)" }
}

function completionNotice(fact: Completion, answer: string) {
	const anchor = `${fact.sessionFile}${fact.response.kind === "response" ? ` entry ${fact.response.entryId}` : " (no response)"}`
	const header = `Subagent ${fact.handle} completed with ${fact.outcome}.\nSource: ${anchor}\n`
	const text = answer
	const provenanceByteReserve = 4 * 1024
	const completionNoticeByteLimit = 16 * 1024 - provenanceByteReserve

	if (Buffer.byteLength(header + text) <= completionNoticeByteLimit) return header + text
	const suffix = "\n[Truncated. Full result at the source above.]"
	const budget = completionNoticeByteLimit - Buffer.byteLength(header + suffix)

	if (budget < 0) throw new Error("Completion source anchor exceeds the message byte limit")
	let body = ""
	let bytes = 0

	for (const character of text) {
		const size = Buffer.byteLength(character)

		if (bytes + size > budget) break
		body += character
		bytes += size
	}

	return header + body + suffix
}

export const COMPLETION_MARKER = "subagent-completion-marker"

const markerSchema = z
	.object({
		parentSessionId: sessionIdSchema,
		relation: relationIdSchema,
		throughSequence: z.number().int().positive(),
		kind: z.enum(["consumed", "wake-committed"]),
	})
	.strict()

export type CompletionInvocation = {
	reserve(handle: RunHandle): void
	terminal(fact: Completion | undefined): void
	commit(): void
	release(): void
}

export class CompletionCoordinator {
	private context: ParentContext | undefined
	private epoch = 0
	private waiters = new Map<RunHandle, Set<symbol>>()
	private consumed = new Map<RelationId, number>()
	private wakes = new Map<RelationId, number>()
	private staged = new Map<RunHandle, number>()
	private diagnosed = new Map<RunHandle, string>()
	constructor(
		private readonly pi: Pick<ParentHost, "appendEntry">,
		private readonly delivery?: Pick<DeliveryService, "stageCompletion">,
	) {}
	start(ctx: ParentContext) {
		this.stop()
		this.context = ctx
		this.consumed.clear()
		this.wakes.clear()

		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== COMPLETION_MARKER) continue
			const parsed = markerSchema.safeParse(entry.data)

			if (!parsed.success || parsed.data.parentSessionId !== ctx.sessionManager.getSessionId()) continue
			const marker = parsed.data
			const map = marker.kind === "consumed" ? this.consumed : this.wakes
			map.set(marker.relation, Math.max(map.get(marker.relation) ?? 0, marker.throughSequence))
		}
	}
	stop() {
		this.epoch++
		this.context = undefined
		this.waiters.clear()
		this.staged.clear()
		this.diagnosed.clear()
	}
	private diagnose(handle: RunHandle, reason: string) {
		if (this.diagnosed.get(handle) === reason) return
		this.pi.appendEntry("session-message-error", reason)
		this.diagnosed.set(handle, reason)
	}
	private mark(fact: Completion, kind: "consumed" | "wake-committed") {
		const map = kind === "consumed" ? this.consumed : this.wakes

		if ((map.get(fact.relation) ?? 0) >= fact.sequence) return
		this.pi.appendEntry(COMPLETION_MARKER, {
			parentSessionId: fact.parentSessionId,
			relation: fact.relation,
			throughSequence: fact.sequence,
			kind,
		})
		map.set(fact.relation, fact.sequence)
	}
	invocation(ctx: ParentContext): CompletionInvocation {
		const epoch = this.epoch
		const token = Symbol()
		const handles = new Set<RunHandle>()
		let terminal: Completion | undefined

		return {
			reserve: (handle) => {
				if (epoch !== this.epoch) throw new Error("Subagent invocation belongs to a retired parent")
				const set = this.waiters.get(handle) ?? new Set<symbol>()
				set.add(token)
				this.waiters.set(handle, set)
				handles.add(handle)
			},
			terminal: (fact) => {
				terminal = fact
			},
			commit: () => {
				if (!terminal) return

				if (epoch !== this.epoch || terminal.parentSessionId !== ctx.sessionManager.getSessionId()) {
					throw new Error("Completion belongs to a retired parent")
				}

				const run = readMetadata(runDirectory(terminal.handle, terminal.parentSessionId))

				if (!run || run.parentSessionId !== terminal.parentSessionId || run.relation !== terminal.relation) {
					throw new Error("Completion ownership changed")
				}

				this.mark(terminal, "consumed")
			},
			release: () => {
				if (epoch !== this.epoch) return

				for (const handle of handles) {
					const set = this.waiters.get(handle)
					set?.delete(token)

					if (!set?.size) this.waiters.delete(handle)
				}
			},
		}
	}
	scan() {
		const ctx = this.context

		if (!ctx || !this.delivery) return
		const epoch = this.epoch

		for (const run of listRuns(sessionIdSchema.parse(ctx.sessionManager.getSessionId()))) {
			if (run.suspended || this.staged.has(run.handle)) continue
			const fact = readCompletion(run)

			if (!fact && run.state === "exited") {
				this.diagnose(
					run.handle,
					`Subagent ${run.handle} exited without a settled completion. Inspect ${run.sessionFile}.`,
				)
			}

			if (
				!fact ||
				fact.sequence <= Math.max(this.consumed.get(fact.relation) ?? 0, this.wakes.get(fact.relation) ?? 0)
			) {
				continue
			}

			let answer: string

			try {
				answer = completionAnswer(fact).answer
			} catch (error) {
				this.diagnose(run.handle, `Subagent ${run.handle} completion source failed: ${String(error)}`)
				continue
			}

			this.diagnosed.delete(run.handle)
			this.delivery.stageCompletion({
				route: { kind: "completion", relation: fact.relation, handle: run.handle, sequence: fact.sequence },
				from: { sessionId: fact.childSessionId, name: run.name },
				text: completionNotice(fact, answer),
				gate: () => {
					if (epoch !== this.epoch) return "withdraw"
					const current = readMetadata(runDirectory(run.handle, run.parentSessionId))

					if (
						!current ||
						current.relation !== fact.relation ||
						current.parentSessionId !== fact.parentSessionId ||
						current.stoppedAt ||
						current.suspended ||
						fact.sequence <= Math.max(this.consumed.get(fact.relation) ?? 0, this.wakes.get(fact.relation) ?? 0)
					) {
						this.staged.delete(run.handle)

						return "withdraw"
					}

					if (this.waiters.get(run.handle)?.size) return "defer"
					this.mark(fact, "wake-committed")
					this.staged.delete(run.handle)

					return "submit"
				},
			})
			this.staged.set(run.handle, fact.sequence)
		}
	}
}

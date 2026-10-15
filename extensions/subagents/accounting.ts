import { randomUUID } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Usage } from "@earendil-works/pi-ai"
import { z } from "zod"
import type { ParentContext, ParentHost } from "./contracts"
import { listRuns, runDirectory } from "./runs"
import { sumUsage } from "./usage"

export const SOURCE_ENTRY = "subagent.usage.v1"

export const CHECKPOINT_ENTRY = "subagent.usage-checkpoint.v1"

export const CHARGE_ENTRY = "subagent.usage-charge.v1"

export const ATTRIBUTION_ENTRY = "subagent.usage-attribution.v1"

const amount = z.number().finite().nonnegative()

const usageSchema = z.object({
	input: amount,
	output: amount,
	cacheRead: amount,
	cacheWrite: amount,
	totalTokens: amount,
	reasoning: amount.optional(),
	cacheWrite1h: amount.optional(),
	cost: z.object({ input: amount, output: amount, cacheRead: amount, cacheWrite: amount, total: amount }),
})

export const sourceSchema = z.object({
	version: z.literal(1),
	parentSessionId: z.string(),
	handle: z.string(),
	name: z.string().optional(),
	sessionFile: z.string(),
	childSessionId: z.string(),
	entryId: z.string(),
	sourceKey: z.string(),
	sourceTimestamp: z.string(),
	kind: z.string(),
	provider: z.string().nullable(),
	model: z.string().nullable(),
	usage: usageSchema,
	billing: z.enum(["eligible", "legacy"]),
})

const fileSchema = z.object({
	path: z.string(),
	childSessionId: z.string().optional(),
	error: z.string().optional(),
})

export const checkpointSchema = z.object({
	version: z.literal(1),
	parentSessionId: z.string(),
	handle: z.string(),
	name: z.string().optional(),
	files: z.array(fileSchema),
	sourceCount: z.number(),
	complete: z.boolean(),
	legacy: z.boolean(),
	stoppedAt: z.string().optional(),
	reason: z.string(),
})

export const chargeSchema = z.object({
	version: z.literal(1),
	chargeId: z.string(),
	parentSessionId: z.string(),
	toolCallId: z.string(),
	parentToolCallId: z.string(),
	sourceKeys: z.array(z.string()),
})

// An index into an already persisted native charge, never another cost-bearing entry.
// The result entry ID disambiguates providers that reuse model-issued tool-call IDs.
export const attributionSchema = z.object({
	version: z.literal(1),
	accounting: z.literal("attribution-only"),
	parentSessionId: z.string(),
	toolCallId: z.string(),
	toolResultEntryId: z.string(),
	chargeIds: z.array(z.string()),
	sourceKeys: z.array(z.string()),
})

type Attribution = z.infer<typeof attributionSchema>

type Source = z.infer<typeof sourceSchema>

type Checkpoint = z.infer<typeof checkpointSchema>

type Charge = z.infer<typeof chargeSchema>

type SourcePart = Pick<
	Source,
	"childSessionId" | "entryId" | "sourceKey" | "sourceTimestamp" | "kind" | "provider" | "model" | "usage"
>

// Parse only the fields accounting owns. In particular, do not load transcripts through
// SessionManager.open(): opening a missing/invalid file can initialize a replacement session.
const headerSchema = z.object({ type: z.literal("session"), id: z.string().min(1) })

const entrySchema = z.object({
	type: z.string(),
	id: z.string().min(1),
	timestamp: z.string(),
	kind: z.string().optional(),
	provider: z.string().optional(),
	model: z.string().optional(),
	usage: usageSchema.optional(),
	message: z
		.object({
			role: z.string(),
			provider: z.string().optional(),
			model: z.string().optional(),
			usage: usageSchema.optional(),
		})
		.optional(),
})

type Transcript = { sources: SourcePart[]; file: z.infer<typeof fileSchema> }

function readTranscript(path: string): Transcript {
	const result: Transcript = { sources: [], file: { path } }

	try {
		const lines = readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.trim())

		// prepareRun creates an empty file before the child's first conversation is flushed.
		if (lines.length === 0) return result
		const header = headerSchema.parse(JSON.parse(lines[0]))
		result.file.childSessionId = header.id

		for (const line of lines.slice(1)) {
			const entry = entrySchema.parse(JSON.parse(line))
			const message = entry.type === "message" ? entry.message : undefined

			const usage =
				message?.role === "assistant" || message?.role === "toolResult"
					? message.usage
					: entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary"
						? entry.usage
						: undefined

			if (!usage) continue
			const attributed = message?.role === "assistant" ? message : entry.type === "usage" ? entry : undefined
			result.sources.push({
				childSessionId: header.id,
				entryId: entry.id,
				sourceKey: JSON.stringify([header.id, entry.id]),
				sourceTimestamp: entry.timestamp,
				kind: message?.role ?? (entry.type === "usage" ? `usage:${entry.kind ?? "unknown"}` : entry.type),
				provider: attributed?.provider ?? null,
				model: attributed?.model ?? null,
				usage,
			})
		}
	} catch (error) {
		// Keep the valid prefix. A partial final write is retried on the next observation.
		result.file.error = error instanceof Error ? error.message : String(error)
	}

	return result
}

function checkpointIdentity(checkpoint: Checkpoint): string {
	const { reason: _reason, ...identity } = checkpoint

	return JSON.stringify(identity)
}

/** Durable source facts plus delivery receipts; no child or parent transcript is rewritten. */
export class UsageAccounting {
	private readonly cache = new Map<string, { fingerprint: string; transcript: Transcript }>()
	// Reservations cover parallel calls before their enclosing result is persisted. On reload,
	// only persisted tool-result receipts count: unacknowledged charges are retried, not lost.
	private readonly inFlight = new Map<string, Charge[]>()

	constructor(private readonly pi: Pick<ParentHost, "appendEntry">) {}

	private ledger(ctx: ParentContext) {
		const sources = new Map<string, Source>()
		const checkpoints = new Map<string, Checkpoint>()
		const charges: Charge[] = []
		const receipts = new Map<string, boolean>()
		const awaitingReceipt = new Map<string, Charge[]>()
		const delivered = new Map<string, Attribution>()
		const attributed = new Set<string>()
		const parentSessionId = ctx.sessionManager.getSessionId()

		// Spending is not branch-relative. Abandoned branches still incurred real charges.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				// Only a later result acknowledges a reservation. Some providers reuse call IDs.
				const pending = awaitingReceipt.get(entry.message.toolCallId) ?? []

				for (const charge of pending) {
					receipts.set(charge.chargeId, entry.message.usage !== undefined)
				}

				if (entry.message.usage !== undefined && pending.length > 0) {
					delivered.set(entry.id, {
						version: 1,
						accounting: "attribution-only",
						parentSessionId,
						toolCallId: entry.message.toolCallId,
						toolResultEntryId: entry.id,
						chargeIds: pending.map((charge) => charge.chargeId),
						sourceKeys: [...new Set(pending.flatMap((charge) => charge.sourceKeys))],
					})
				}

				awaitingReceipt.delete(entry.message.toolCallId)
			}

			if (entry.type !== "custom") continue

			if (entry.customType === SOURCE_ENTRY) {
				const source = sourceSchema.parse(entry.data)

				if (source.parentSessionId === parentSessionId) sources.set(source.sourceKey, source)
			} else if (entry.customType === CHECKPOINT_ENTRY) {
				const checkpoint = checkpointSchema.parse(entry.data)

				if (checkpoint.parentSessionId === parentSessionId) checkpoints.set(checkpoint.handle, checkpoint)
			} else if (entry.customType === ATTRIBUTION_ENTRY) {
				const attribution = attributionSchema.parse(entry.data)

				if (attribution.parentSessionId === parentSessionId) attributed.add(attribution.toolResultEntryId)
			} else if (entry.customType === CHARGE_ENTRY) {
				const charge = chargeSchema.parse(entry.data)

				if (charge.parentSessionId === parentSessionId) {
					charges.push(charge)
					const pending = awaitingReceipt.get(charge.parentToolCallId) ?? []
					pending.push(charge)
					awaitingReceipt.set(charge.parentToolCallId, pending)
				}
			}
		}

		return { sources, checkpoints, charges, receipts, delivered, attributed }
	}

	private transcript(path: string): Transcript {
		try {
			const stat = statSync(path)
			const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
			const cached = this.cache.get(path)

			if (cached?.fingerprint === fingerprint) return cached.transcript
			const transcript = readTranscript(path)

			if (!transcript.file.error) this.cache.set(path, { fingerprint, transcript })

			return transcript
		} catch (error) {
			return { sources: [], file: { path, error: error instanceof Error ? error.message : String(error) } }
		}
	}

	reconcile(ctx: ParentContext, reason: string): void {
		const parentSessionId = ctx.sessionManager.getSessionId()
		const ledger = this.ledger(ctx)

		// Materialize confirmed links only after Pi has persisted its native result. A crash
		// between result and annotation is repaired here on startup; links never drive billing.
		for (const [entryId, attribution] of ledger.delivered) {
			if (!ledger.attributed.has(entryId)) this.pi.appendEntry(ATTRIBUTION_ENTRY, attribution)
		}

		for (const run of listRuns(parentSessionId, { includeStopped: true })) {
			const paths = new Set([
				join(runDirectory(run.handle), "session.jsonl"),
				...(run.sessionFiles ?? []),
				run.sessionFile,
			])

			const files: z.infer<typeof fileSchema>[] = []
			const keys = new Set<string>()

			for (const path of paths) {
				const transcript = this.transcript(path)
				files.push(transcript.file)

				for (const part of transcript.sources) {
					keys.add(part.sourceKey)

					if (ledger.sources.has(part.sourceKey)) continue

					const source: Source = {
						version: 1,
						parentSessionId,
						handle: run.handle,
						sessionFile: path,
						...part,
						billing: run.accountingVersion === 1 ? "eligible" : "legacy",
					}

					if (run.name !== undefined) source.name = run.name
					this.pi.appendEntry(SOURCE_ENTRY, source)
					ledger.sources.set(part.sourceKey, source)
				}
			}

			const checkpoint: Checkpoint = {
				version: 1,
				parentSessionId,
				handle: run.handle,
				files,
				sourceCount: keys.size,
				complete: files.every((file) => !file.error),
				legacy: run.accountingVersion !== 1,
				reason,
			}

			if (run.name !== undefined) checkpoint.name = run.name

			if (run.stoppedAt !== undefined) checkpoint.stoppedAt = run.stoppedAt
			const previous = ledger.checkpoints.get(run.handle)

			if (!previous || checkpointIdentity(previous) !== checkpointIdentity(checkpoint)) {
				this.pi.appendEntry(CHECKPOINT_ENTRY, checkpoint)
			}
		}
	}

	// Called only at parent settlement/shutdown, when no tool result remains in flight.
	releaseReservations(ctx: ParentContext): void {
		this.inFlight.delete(ctx.sessionManager.getSessionId())
	}

	charge(ctx: ParentContext, toolCallId: string): Usage | undefined {
		const parentSessionId = ctx.sessionManager.getSessionId()
		const { sources, charges, receipts } = this.ledger(ctx)
		const delivered = new Set<string>()

		for (const charge of charges) {
			if (receipts.get(charge.chargeId)) {
				for (const key of charge.sourceKeys) delivered.add(key)
			}
		}

		const inFlight = (this.inFlight.get(parentSessionId) ?? []).filter((charge) => !receipts.has(charge.chargeId))

		this.inFlight.set(parentSessionId, inFlight)

		for (const charge of inFlight) {
			for (const key of charge.sourceKeys) delivered.add(key)
		}

		const pending = [...sources.values()].filter(
			(source) => source.billing === "eligible" && !delivered.has(source.sourceKey),
		)

		if (pending.length === 0) return undefined
		// Nested calls are named <model-issued id>/<n>. Match the actual declaration rather
		// than splitting on '/', which itself can occur in a provider-issued call id.
		let parentToolCallId = toolCallId
		let matched = 0

		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue

			for (const content of entry.message.content) {
				if (content.type !== "toolCall" || content.id.length <= matched) continue

				if (toolCallId === content.id || toolCallId.startsWith(`${content.id}/`)) {
					parentToolCallId = content.id
					matched = content.id.length
				}
			}
		}

		const charge: Charge = {
			version: 1,
			chargeId: randomUUID(),
			parentSessionId,
			toolCallId,
			parentToolCallId,
			sourceKeys: pending.map((source) => source.sourceKey),
		}

		this.pi.appendEntry(CHARGE_ENTRY, charge)
		inFlight.push(charge)

		return sumUsage(pending.map((source) => source.usage))
	}
}

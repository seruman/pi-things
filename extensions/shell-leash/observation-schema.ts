import { z } from "zod"
import type { AnalysisObservation } from "./findings"
import { type Result, err, ok } from "./result"

export const analysisObservationSchema = z.discriminatedUnion("kind", [
	z
		.object({ kind: z.literal("parser-failure"), stage: z.enum(["initialization", "parse"]), message: z.string() })
		.strict(),
	z.object({ kind: z.literal("recursion-limit"), source: z.string() }).strict(),
	z
		.object({
			kind: z.literal("dynamic-executable"),
			source: z.string(),
			startByte: z.number().int().nonnegative(),
			endByte: z.number().int().nonnegative(),
		})
		.strict(),
	z.object({ kind: z.literal("dynamic-argument"), source: z.string(), index: z.number().int() }).strict(),
	z.object({ kind: z.literal("embedded-dynamic"), interpreter: z.string(), source: z.string() }).strict(),
	z.object({ kind: z.literal("unknown-git"), argv: z.array(z.string()).readonly() }).strict(),
	z.object({ kind: z.literal("git-scope-override"), setting: z.string(), value: z.string() }).strict(),
	z.object({ kind: z.literal("unknown-github"), argv: z.array(z.string()).readonly() }).strict(),
	z.object({ kind: z.literal("github-graphql-unknown"), source: z.string() }).strict(),
	z
		.object({
			kind: z.literal("shell-syntax"),
			issue: z.enum(["syntax-error", "missing-syntax"]),
			text: z.string(),
			startByte: z.number().int().nonnegative(),
			endByte: z.number().int().nonnegative(),
		})
		.strict(),
	z.object({ kind: z.literal("runtime-log-error"), errorKind: z.string(), message: z.string() }).strict(),
])

const observationSourceSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("static"), command: z.string() }).strict(),
	z.object({ kind: z.literal("runtime"), argv: z.array(z.string()).readonly() }).strict(),
])

const observationProvenanceSchema = z
	.object({
		project: z.string(),
		revision: z.string().optional(),
		sourcePath: z.string().optional(),
		mode: z.string(),
	})
	.strict()

export const shellLeashObservationEnvelopeSchema = z
	.object({
		version: z.literal(1),
		requestId: z.string().min(1),
		toolCallId: z.string().min(1),
		createdAt: z.string().datetime({ offset: true }),
		cwd: z.string().min(1),
		source: observationSourceSchema,
		observation: analysisObservationSchema,
		explanation: z.string().min(1),
		provenance: observationProvenanceSchema.optional(),
	})
	.strict()

export type ShellLeashObservationEnvelope = z.infer<typeof shellLeashObservationEnvelopeSchema>
export type ShellLeashSerializedObservation = z.infer<typeof analysisObservationSchema>

export function parseShellLeashObservationEnvelope(
	input: unknown,
): Result<ShellLeashObservationEnvelope, { readonly kind: "invalid-observation"; readonly message: string }> {
	const parsed = shellLeashObservationEnvelopeSchema.safeParse(input)
	return parsed.success
		? ok(parsed.data)
		: err({ kind: "invalid-observation", message: parsed.error.issues.map((issue) => issue.message).join("; ") })
}

export function createShellLeashObservationEnvelope(input: {
	readonly requestId: string
	readonly toolCallId: string
	readonly cwd: string
	readonly source: ShellLeashObservationEnvelope["source"]
	readonly observation:
		| AnalysisObservation
		| { readonly kind: "runtime-log-error"; readonly errorKind: string; readonly message: string }
	readonly createdAt?: string
}): ShellLeashObservationEnvelope {
	return {
		version: 1,
		requestId: input.requestId,
		toolCallId: input.toolCallId,
		createdAt: input.createdAt ?? new Date().toISOString(),
		cwd: input.cwd,
		source: input.source,
		observation: input.observation,
		explanation: explainObservation(input.observation),
	}
}

export function summarizeShellLeashObservations(entries: readonly unknown[]): string {
	const parsed: ShellLeashObservationEnvelope[] = []
	let invalid = 0
	for (const entry of entries) {
		const observation = parseShellLeashObservationEnvelope(entry)
		if (observation.ok) parsed.push(observation.value)
		else invalid++
	}
	if (parsed.length === 0 && invalid === 0) return "shell-leash: no hidden observations"
	const counts = new Map<string, number>()
	for (const entry of parsed) counts.set(entry.observation.kind, (counts.get(entry.observation.kind) ?? 0) + 1)
	const countLines = [...counts]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([kind, count]) => `${kind}: ${count}`)
	if (invalid > 0) countLines.push(`invalid-envelope: ${invalid}`)
	const selected = parsed.slice(-5).map((entry) => `${entry.createdAt} ${entry.explanation}`)
	return [
		`shell-leash: ${entries.length} hidden observation(s)`,
		...countLines,
		...(selected.length ? ["recent:", ...selected] : []),
	].join("\n")
}

export function explainObservation(
	observation:
		| AnalysisObservation
		| { readonly kind: "runtime-log-error"; readonly errorKind: string; readonly message: string },
): string {
	switch (observation.kind) {
		case "parser-failure":
			return `Bash parser ${observation.stage} failure: ${observation.message}`
		case "recursion-limit":
			return "Static nested-script analysis reached its recursion limit"
		case "dynamic-executable":
			return `Executable is dynamic: ${observation.source}`
		case "dynamic-argument":
			return `Argument ${observation.index} is dynamic: ${observation.source}`
		case "embedded-dynamic":
			return `${observation.interpreter} embedded process invocation is dynamic`
		case "unknown-git":
			return `Git operation is unknown: ${observation.argv.join(" ")}`
		case "git-scope-override":
			return `Git config can change command or remote scope: ${observation.setting}`
		case "unknown-github":
			return `GitHub CLI operation is unknown: ${observation.argv.join(" ")}`
		case "github-graphql-unknown":
			return "GraphQL operation cannot be classified statically"
		case "shell-syntax":
			return `Bash contains ${observation.issue} at bytes ${observation.startByte}-${observation.endByte}`
		case "runtime-log-error":
			return `Runtime observation log ${observation.errorKind}: ${observation.message}`
		default:
			return observation satisfies never
	}
}

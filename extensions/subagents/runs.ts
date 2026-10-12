import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ThinkingLevel } from "@earendil-works/pi-agent-core"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { z } from "zod"

export const thinkingLevels = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[]

// Persisted names must already be normalized; only user input is trimmed.
const runNameSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^\S(?:[\s\S]*\S)?$/, "Subagent names must not have surrounding whitespace")
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject terminal control characters.
	.regex(/^[^\u0000-\u001f\u007f]*$/, "Subagent names must not contain terminal control characters")

export function normalizeRunName(value: string): string {
	return runNameSchema.parse(value.trim())
}

const runMetadataSchema = z.object({
	version: z.literal(1),
	handle: z.string(),
	name: runNameSchema.optional(),
	blockId: z.string(),
	parentSessionId: z.string(),
	childSessionId: z.string().optional(),
	sessionFile: z.string(),
	cwd: z.string(),
	provider: z.string(),
	model: z.string(),
	thinking: z.enum(thinkingLevels),
	launchArgs: z.array(z.string()),
	suspended: z.boolean().optional(),
	// Upstream bridge lifecycle; optional for metadata written before lifecycle tracking.
	state: z.enum(["starting", "busy", "idle", "exited", "error"]).optional(),
	hasStarted: z.boolean().optional(),
	error: z.string().optional(),
	createdAt: z.string(),
})

export type RunMetadata = z.infer<typeof runMetadataSchema>

export function runDisplayName(metadata: Pick<RunMetadata, "handle" | "name">): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle
}

export const inboxMessageSchema = z.object({
	message: z.string(),
	delivery: z.enum(["auto", "followUp"]),
})

function getRunsDir(): string {
	return join(getAgentDir(), "subagents")
}

export function runDirectory(handle: string): string {
	if (!/^[a-z0-9]+$/.test(handle)) throw new Error(`Invalid subagent handle: ${handle}`)

	return join(getRunsDir(), handle)
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox")
}

export function metadataPath(runDir: string): string {
	return join(runDir, "metadata.json")
}

function generateHandle(): string {
	mkdirSync(getRunsDir(), { recursive: true, mode: 0o700 })

	for (let attempt = 0; attempt < 100; attempt++) {
		const handle = randomBytes(3).toString("hex")

		if (!existsSync(runDirectory(handle))) return handle
	}

	throw new Error("Could not allocate a unique subagent handle")
}

export function prepareRun(): Pick<RunMetadata, "handle" | "sessionFile"> {
	const handle = generateHandle()
	const directory = runDirectory(handle)
	const sessionFile = join(directory, "session.jsonl")
	mkdirSync(inboxDir(directory), { recursive: true, mode: 0o700 })
	writeFileSync(sessionFile, "", { mode: 0o600 })

	return { handle, sessionFile }
}

export function readMetadata(runDir: string): RunMetadata | undefined {
	try {
		return runMetadataSchema.safeParse(JSON.parse(readFileSync(metadataPath(runDir), "utf8"))).data
	} catch {
		return undefined
	}
}

export function getRun(handle: string): RunMetadata {
	const metadata = readMetadata(runDirectory(handle))

	if (!metadata) throw new Error(`Unknown subagent: ${handle}`)

	return metadata
}

export function writeMetadata(metadata: RunMetadata): void {
	const value = runMetadataSchema.parse(metadata)
	const target = metadataPath(runDirectory(value.handle))
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
	renameSync(temporary, target)
}

// Same metadata update flow as pi-subagent; the bridge applies names through Pi's SDK.
export function updateMetadata(
	runDir: string,
	patch: Partial<RunMetadata>,
	clear: readonly ("error" | "suspended")[] = [],
): RunMetadata | undefined {
	const current = readMetadata(runDir)

	if (!current) return undefined

	const next: RunMetadata = {
		...current,
		...patch,
		version: 1,
		handle: current.handle,
	}

	for (const field of clear) delete next[field]
	writeMetadata(next)

	return next
}

export function listRuns(parentSessionId?: string): RunMetadata[] {
	const root = getRunsDir()

	if (!existsSync(root)) return []
	const runs: RunMetadata[] = []

	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue
		const dir = join(root, entry.name)

		if (!existsSync(metadataPath(dir))) continue
		const metadata = readMetadata(dir)

		if (!metadata) continue

		if (parentSessionId && metadata.parentSessionId !== parentSessionId) continue
		runs.push(metadata)
	}

	return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function removeRunDir(handle: string): void {
	rmSync(runDirectory(handle), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

export function enqueue(handle: string, message: string, followUp: boolean): void {
	const directory = inboxDir(runDirectory(handle))
	mkdirSync(directory, { recursive: true, mode: 0o700 })
	const target = join(directory, `${Date.now()}-${randomBytes(4).toString("hex")}.json`)
	const temporary = `${target}.tmp`
	const payload = inboxMessageSchema.parse({ message, delivery: followUp ? "followUp" : "auto" })
	writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 })
	renameSync(temporary, target)
}

export function inboxPending(handle: string): boolean {
	const directory = inboxDir(runDirectory(handle))

	if (!existsSync(directory)) return false

	return readdirSync(directory).some((file) => file.endsWith(".json"))
}

import { randomBytes, randomUUID } from "node:crypto"
// Default import: tests spy on these calls to prove which run files a scan opens.
import fs from "node:fs"
import { join } from "node:path"
import type { ThinkingLevel } from "@earendil-works/pi-agent-core"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { z } from "zod"
import {
	relationIdSchema,
	runHandleSchema,
	sessionIdSchema,
	type RunHandle,
	type SessionId,
} from "../lib/session-delivery/identity"

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
	// oxlint-disable-next-line no-control-regex -- Reject terminal control characters.
	.regex(/^[^\u0000-\u001f\u007f]*$/, "Subagent names must not contain terminal control characters")

export function normalizeRunName(value: string): string {
	return runNameSchema.parse(value.trim())
}

const runMetadataSchema = z.object({
	version: z.literal(1),
	handle: runHandleSchema,
	relation: relationIdSchema.optional(),
	name: runNameSchema.optional(),
	blockId: z.string(),
	parentSessionId: sessionIdSchema,
	childSessionId: sessionIdSchema.optional(),
	sessionFile: z.string(),
	launchSessionFile: z.string().optional(),
	// All session paths seen by the bridge; usage must survive child session switches.
	sessionFiles: z.array(z.string()).optional(),
	// Legacy runs have no reliable record of which usage was already returned to Pi.
	accountingVersion: z.literal(1).optional(),
	cwd: z.string(),
	provider: z.string(),
	model: z.string(),
	thinking: z.enum(thinkingLevels),
	launchArgs: z.array(z.string()),
	suspended: z.boolean().optional(),
	// Parent-owned terminal marker, independent of bridge lifecycle updates.
	stoppedAt: z.string().optional(),
	// Upstream bridge lifecycle; optional for metadata written before lifecycle tracking.
	state: z.enum(["starting", "busy", "idle", "exited", "error"]).optional(),
	hasStarted: z.boolean().optional(),
	// Last settled turn; published by the bridge, never inferred from process liveness.
	outcome: z.enum(["success", "error", "aborted"]).optional(),
	error: z.string().optional(),
	createdAt: z.string(),
})

export type RunMetadata = z.infer<typeof runMetadataSchema>

export function runDisplayName(metadata: { handle: string; name?: string }): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle
}

function getRunsDir(): string {
	return join(getAgentDir(), "subagents")
}

// Runs live at <root>/by-parent/<parent session id>/<handle>, so a session lists its runs
// by reading its own folder only. Nothing outside by-parent is ever read.
const PARENTS = "by-parent"

const handlePattern = /^[a-z0-9]+$/

// Pi's --session-id alphabet. Anything else is not trusted as a path segment.
const parentSegmentPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/

function parentDirectory(parentSessionId: SessionId): string {
	if (!parentSegmentPattern.test(parentSessionId)) {
		throw new Error(`Session id ${JSON.stringify(parentSessionId)} is not usable as a subagent directory name`)
	}

	return join(getRunsDir(), PARENTS, parentSessionId)
}

function directories(path: string): string[] {
	try {
		return fs
			.readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
	} catch (error) {
		if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return []
		throw error
	}
}

function nestedDirectories(handle: RunHandle): string[] {
	const parents = join(getRunsDir(), PARENTS)

	return directories(parents)
		.map((parent) => join(parents, parent, handle))
		.filter((path) => fs.existsSync(path))
}

// Pass the parent wherever it is known: the path is then computed without touching the
// disk. Without it every parent folder is probed, so keep that form off timer paths.
export function runDirectory(handle: RunHandle, parentSessionId?: SessionId): string {
	if (!handlePattern.test(handle)) throw new Error(`Invalid subagent handle: ${handle}`)

	if (parentSessionId !== undefined) return join(parentDirectory(parentSessionId), handle)
	const found = nestedDirectories(handle)[0]

	if (!found) throw new Error(`Unknown subagent: ${handle}`)

	return found
}

export function metadataPath(runDir: string): string {
	return join(runDir, "metadata.json")
}

// Handles stay unique across parents: Rex pane labels, status ids and handle-only lookups use them bare.
function generateHandle(): RunHandle {
	for (let attempt = 0; attempt < 100; attempt++) {
		const handle = runHandleSchema.parse(randomBytes(3).toString("hex"))

		if (nestedDirectories(handle).length === 0) return handle
	}

	throw new Error("Could not allocate a unique subagent handle")
}

const runIdentitySchema = z
	.object({
		handle: z
			.string()
			.regex(/^[a-z0-9]+$/)
			.pipe(runHandleSchema),
		relation: relationIdSchema,
		parentSessionId: z.string().min(1).pipe(sessionIdSchema),
	})
	.strict()
	.readonly()

export type RunIdentity = z.infer<typeof runIdentitySchema>

export function readRunIdentity(runDir: string): RunIdentity | undefined {
	try {
		return runIdentitySchema.parse(JSON.parse(fs.readFileSync(join(runDir, "identity.json"), "utf8")))
	} catch {
		return undefined
	}
}

export function prepareRun(parentSessionId: SessionId) {
	// Validate the owner before allocating anything: an unusable id must not spawn.
	const parent = parentDirectory(parentSessionId)
	const handle = generateHandle()
	const directory = join(parent, handle)
	const sessionFile = join(directory, "session.jsonl")
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
	fs.writeFileSync(sessionFile, "", { mode: 0o600 })
	const relation = relationIdSchema.parse(randomUUID())

	fs.writeFileSync(
		join(directory, "identity.json"),
		JSON.stringify(runIdentitySchema.parse({ handle, relation, parentSessionId })),
		{ mode: 0o600, flag: "wx" },
	)

	return { handle, sessionFile, relation }
}

export function readMetadata(runDir: string): RunMetadata | undefined {
	try {
		return runMetadataSchema.safeParse(JSON.parse(fs.readFileSync(metadataPath(runDir), "utf8"))).data
	} catch {
		return undefined
	}
}

export function getRun(handle: RunHandle, parentSessionId?: SessionId): RunMetadata {
	const metadata = readMetadata(runDirectory(handle, parentSessionId))

	if (!metadata) throw new Error(`Unknown subagent: ${handle}`)

	return metadata
}

function write(runDir: string, metadata: RunMetadata): void {
	const value = runMetadataSchema.parse(metadata)
	const target = metadataPath(runDir)
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
	fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
	fs.renameSync(temporary, target)
}

export function writeMetadata(metadata: RunMetadata): void {
	write(runDirectory(metadata.handle, metadata.parentSessionId), metadata)
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
		// The owner decides where a run is stored and who may list it; it never changes.
		parentSessionId: current.parentSessionId,
	}

	for (const field of clear) delete next[field]
	write(runDir, next)

	return next
}

function runDirectories(parentSessionId: SessionId | undefined): string[] {
	const parents = join(getRunsDir(), PARENTS)
	const owners = parentSessionId === undefined ? directories(parents) : [parentSessionId]

	return owners.flatMap((owner) =>
		directories(join(parents, owner))
			.filter((handle) => handlePattern.test(handle))
			.map((handle) => join(parents, owner, handle)),
	)
}

export function listRuns(parentSessionId?: SessionId, options: { includeStopped?: boolean } = {}): RunMetadata[] {
	const runs: RunMetadata[] = []

	// An unusable session id owns no runs: spawning under it is refused.
	if (parentSessionId !== undefined && !parentSegmentPattern.test(parentSessionId)) return []

	for (const dir of runDirectories(parentSessionId)) {
		// A prepared run has no metadata until its child has launched.
		const metadata = readMetadata(dir)

		if (!metadata || (metadata.stoppedAt && !options.includeStopped)) continue

		// Session ids that differ only by case share a folder on case-insensitive filesystems.
		if (parentSessionId !== undefined && metadata.parentSessionId !== parentSessionId) continue
		runs.push(metadata)
	}

	return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

// Call only after the Rex block is closed or known to be absent. Never delete history.
export function markStopped(handle: RunHandle, parentSessionId?: SessionId): RunMetadata {
	const directory = runDirectory(handle, parentSessionId)
	const current = readMetadata(directory)

	if (!current) throw new Error(`Unknown subagent: ${handle}`)

	const stopped = updateMetadata(directory, {
		stoppedAt: current.stoppedAt ?? new Date().toISOString(),
		suspended: false,
	})

	if (!stopped) throw new Error(`Could not retain stopped subagent: ${handle}`)

	return stopped
}

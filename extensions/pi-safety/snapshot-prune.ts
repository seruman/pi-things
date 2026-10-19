import * as fs from "node:fs"
import * as path from "node:path"
import { type Result, err, ok } from "./result"
import { parseSnapshotId } from "./snapshot"

export interface SnapshotPruneOptions {
	readonly snapshotsRoot: string
	readonly maxSnapshots: number
	readonly maxAgeMs: number
	readonly now: number
	readonly execution: "apply" | "dry-run"
}

export type SnapshotPruneReason = "expired" | "over-limit" | "stale-staging" | "empty-project"

export type SnapshotPruneAction =
	| { readonly kind: "remove"; readonly path: string; readonly reason: SnapshotPruneReason }
	| { readonly kind: "skip"; readonly path: string; readonly reason: "locked" }

export type SnapshotPruneError = {
	readonly kind: "io"
	readonly operation: string
	readonly path: string
	readonly message: string
}

const PROJECT_DIRECTORY_PATTERN = /^[0-9a-f]{24}$/

// Leftovers from an interrupted snapshot. Safe to remove only while holding the project lock.
const STALE_ENTRY_PREFIXES = [".staging-", ".clone-probe-"] as const

/**
 * Applies age and count retention to every project in the snapshot store and removes leftovers
 * from interrupted snapshots. Projects with a held lock are skipped; a lock left by a killed
 * process is reported so it can be removed by hand.
 */
export function pruneSnapshotStores(options: SnapshotPruneOptions): Result<SnapshotPruneAction[], SnapshotPruneError> {
	let projects: string[]

	try {
		projects = fs
			.readdirSync(options.snapshotsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && PROJECT_DIRECTORY_PATTERN.test(entry.name))
			.map((entry) => entry.name)
			.sort()
	} catch (cause) {
		if (isMissing(cause)) return ok([])

		return ioError("read-snapshot-root", options.snapshotsRoot, cause)
	}

	const actions: SnapshotPruneAction[] = []

	for (const project of projects) {
		const pruned = pruneProject(path.join(options.snapshotsRoot, project), options)

		if (!pruned.ok) return pruned
		actions.push(...pruned.value)
	}

	return ok(actions)
}

function pruneProject(
	projectDirectory: string,
	options: SnapshotPruneOptions,
): Result<SnapshotPruneAction[], SnapshotPruneError> {
	const lockDirectory = path.join(projectDirectory, ".lock")

	// Take the same lock snapshot creation uses so a running checkpoint cannot race with removal.
	try {
		if (options.execution === "apply") fs.mkdirSync(lockDirectory, { mode: 0o700 })
		else if (fs.existsSync(lockDirectory)) return ok([{ kind: "skip", path: lockDirectory, reason: "locked" }])
	} catch (cause) {
		if (fs.existsSync(lockDirectory)) return ok([{ kind: "skip", path: lockDirectory, reason: "locked" }])

		return ioError("acquire-lock", lockDirectory, cause)
	}

	let actions: Result<SnapshotPruneAction[], SnapshotPruneError>

	try {
		actions = planProject(projectDirectory, options)

		if (actions.ok && options.execution === "apply") {
			for (const action of actions.value) {
				if (action.kind !== "remove" || action.reason === "empty-project") continue
				fs.rmSync(action.path, { recursive: true, force: true })
			}
		}
	} catch (cause) {
		actions = ioError("prune-project", projectDirectory, cause)
	} finally {
		if (options.execution === "apply") fs.rmSync(lockDirectory, { recursive: true, force: true })
	}

	if (!actions.ok) return actions
	const emptyProject = actions.value.find((action) => action.reason === "empty-project")

	if (emptyProject !== undefined && options.execution === "apply") {
		try {
			// rmdir only succeeds on an empty directory, so a snapshot published meanwhile is kept.
			fs.rmdirSync(projectDirectory)
		} catch (cause) {
			if (!isNotEmpty(cause)) return ioError("remove-empty-project", projectDirectory, cause)
		}
	}

	return actions
}

function planProject(
	projectDirectory: string,
	options: SnapshotPruneOptions,
): Result<SnapshotPruneAction[], SnapshotPruneError> {
	let entries: fs.Dirent[]

	try {
		entries = fs.readdirSync(projectDirectory, { withFileTypes: true })
	} catch (cause) {
		return ioError("read-project", projectDirectory, cause)
	}

	const actions: SnapshotPruneAction[] = []

	const snapshots = entries
		.filter((entry) => entry.isDirectory() && parseSnapshotId(entry.name).ok)
		.map((entry) => entry.name)
		.sort()

	const kept: string[] = []

	for (const id of snapshots) {
		const createdAt = snapshotTimestamp(id)

		if (createdAt !== undefined && options.now - createdAt > options.maxAgeMs) {
			actions.push({ kind: "remove", path: path.join(projectDirectory, id), reason: "expired" })
		} else {
			kept.push(id)
		}
	}

	for (const id of kept.slice(0, Math.max(0, kept.length - options.maxSnapshots))) {
		actions.push({ kind: "remove", path: path.join(projectDirectory, id), reason: "over-limit" })
	}

	const stale = entries.filter((entry) => STALE_ENTRY_PREFIXES.some((prefix) => entry.name.startsWith(prefix)))

	for (const entry of stale) {
		actions.push({ kind: "remove", path: path.join(projectDirectory, entry.name), reason: "stale-staging" })
	}

	const removed = new Set(actions.map((action) => path.basename(action.path)))
	const remaining = entries.filter((entry) => entry.name !== ".lock" && !removed.has(entry.name))

	if (remaining.length === 0) actions.push({ kind: "remove", path: projectDirectory, reason: "empty-project" })

	return ok(actions)
}

// Snapshot IDs start with the compact UTC creation time: YYYYMMDDHHMMSSmmm.
function snapshotTimestamp(id: string): number | undefined {
	const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})-/.exec(id)

	if (match === null) return undefined
	const [year, month, day, hour, minute, second, millisecond] = match.slice(1).map(Number)
	const timestamp = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)

	return Number.isFinite(timestamp) ? timestamp : undefined
}

export function describeSnapshotPrune(
	actions: readonly SnapshotPruneAction[],
	execution: SnapshotPruneOptions["execution"],
): string {
	const lines = actions.map((action) => `${action.kind}\t${action.reason}\t${action.path}`)

	const removedSnapshots = actions.filter(
		(action) => action.kind === "remove" && (action.reason === "expired" || action.reason === "over-limit"),
	).length

	const summary =
		execution === "apply"
			? `removed ${removedSnapshots} snapshots`
			: `would remove ${removedSnapshots} snapshots; pass --apply to remove them`

	return [...lines, summary].join("\n")
}

function isMissing(cause: unknown): boolean {
	return cause instanceof Error && "code" in cause && cause.code === "ENOENT"
}

function isNotEmpty(cause: unknown): boolean {
	return cause instanceof Error && "code" in cause && (cause.code === "ENOTEMPTY" || cause.code === "EEXIST")
}

function ioError(operation: string, pathname: string, cause: unknown): Result<never, SnapshotPruneError> {
	return err({ kind: "io", operation, path: pathname, message: cause instanceof Error ? cause.message : String(cause) })
}

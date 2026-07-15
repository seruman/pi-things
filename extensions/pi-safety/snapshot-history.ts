import * as fs from "node:fs"
import * as path from "node:path"
import { readApfsPrivateSize } from "./apfs-private-size"
import { type CanonicalPath, appendCanonicalPath, isCanonicalPathWithin, parseCanonicalPath } from "./canonical-path"
import { readJsonFile } from "./json-file"
import { type Result, err, ok } from "./result"
import {
	type SnapshotId,
	type SnapshotOrigin,
	type SnapshotStore,
	classifySnapshotStorage,
	parseSnapshotId,
	storedSnapshotPath,
} from "./snapshot"
import {
	type SnapshotManifest,
	type SnapshotManifestError,
	parseSnapshotManifest,
	snapshotManifestSchema,
	snapshotManifestSchemaError,
} from "./snapshot-manifest"

const loadedSnapshotBrand: unique symbol = Symbol("LoadedSnapshot")

export interface SnapshotSummary {
	readonly id: SnapshotId
	readonly createdAt: string
	readonly workspace: CanonicalPath
	readonly origin: SnapshotOrigin
	readonly entryCount: number
	readonly reclaimableBytes: bigint | undefined
}

export interface LoadedSnapshot {
	readonly directory: CanonicalPath
	readonly manifest: SnapshotManifest
	readonly [loadedSnapshotBrand]: true
}

export type SnapshotHistoryAccess = { readonly kind: "verify-policy" } | { readonly kind: "immutable-store" }

export type SnapshotHistoryError =
	| { readonly kind: "io"; readonly operation: string; readonly path: string; readonly message: string }
	| { readonly kind: "manifest"; readonly path: string; readonly cause: SnapshotManifestError }
	| { readonly kind: "snapshot-id-mismatch"; readonly expected: SnapshotId; readonly actual: SnapshotId }
	| { readonly kind: "workspace-mismatch"; readonly expected: CanonicalPath; readonly actual: CanonicalPath }
	| { readonly kind: "storage-classification-mismatch"; readonly path: string }
	| { readonly kind: "stored-entry-mismatch"; readonly path: string; readonly expected: string }

export function listSnapshots(
	store: SnapshotStore,
	access: SnapshotHistoryAccess = { kind: "verify-policy" },
): Result<readonly SnapshotSummary[], SnapshotHistoryError> {
	if (!fs.existsSync(store.projectDirectory)) return ok([])
	let names: string[]
	try {
		names = fs
			.readdirSync(store.projectDirectory, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && parseSnapshotId(entry.name).ok)
			.map((entry) => entry.name)
			.sort()
			.reverse()
	} catch (cause) {
		return ioError("list-snapshots", store.projectDirectory, cause)
	}
	const summaries: SnapshotSummary[] = []
	for (const name of names) {
		const id = parseSnapshotId(name)
		if (!id.ok) continue
		const loaded = loadSnapshot(store, id.value, access)
		if (!loaded.ok) return loaded
		summaries.push(
			Object.freeze({
				id: loaded.value.manifest.id,
				createdAt: loaded.value.manifest.createdAt,
				workspace: loaded.value.manifest.workspace,
				origin: loaded.value.manifest.origin,
				entryCount: loaded.value.manifest.entries.length,
				reclaimableBytes: access.kind === "verify-policy" ? reclaimableSnapshotBytes(loaded.value) : undefined,
			}),
		)
	}
	return ok(Object.freeze(summaries))
}

export function loadSnapshot(
	store: SnapshotStore,
	id: SnapshotId,
	access: SnapshotHistoryAccess = { kind: "verify-policy" },
): Result<LoadedSnapshot, SnapshotHistoryError> {
	const directoryPath = path.join(store.projectDirectory, id)
	const parsedDirectory = parseCanonicalPath(directoryPath)
	if (!parsedDirectory.ok) return ioError("resolve-snapshot", directoryPath, JSON.stringify(parsedDirectory.error))
	const directory = parsedDirectory.value
	if (!isCanonicalPathWithin(store.projectDirectory, directory)) {
		return ioError("resolve-snapshot", directoryPath, "snapshot resolves outside its project store")
	}
	const manifestPath = path.join(directory, "manifest.json")
	const input = readJsonFile(manifestPath, snapshotManifestSchema)
	if (!input.ok) {
		return input.error.kind === "json-file-schema"
			? err({ kind: "manifest", path: manifestPath, cause: snapshotManifestSchemaError(input.error.cause) })
			: ioError("read-manifest", manifestPath, input.error.message)
	}
	const manifest = parseSnapshotManifest(input.value, store.filePolicy)
	if (!manifest.ok) return err({ kind: "manifest", path: manifestPath, cause: manifest.error })
	if (manifest.value.id !== id) {
		return err({ kind: "snapshot-id-mismatch", expected: id, actual: manifest.value.id })
	}
	if (manifest.value.workspace !== store.workspaceRoot) {
		return err({ kind: "workspace-mismatch", expected: store.workspaceRoot, actual: manifest.value.workspace })
	}
	switch (access.kind) {
		case "verify-policy":
			for (const entry of manifest.value.entries) {
				if (entry.kind !== "file") continue
				const workspacePath = path.join(store.workspaceRoot, entry.path)
				const canonical = appendCanonicalPath(store.workspaceRoot, entry.path.split(path.sep))
				if (!canonical.ok) return ioError("classify-snapshot-entry", workspacePath, JSON.stringify(canonical.error))
				if (classifySnapshotStorage(store.filePolicy, canonical.value).kind !== entry.storage.kind) {
					return err({ kind: "storage-classification-mismatch", path: entry.path })
				}
			}
			break
		case "immutable-store":
			break
		default:
			return assertNever(access)
	}
	return ok(Object.freeze({ directory, manifest: manifest.value }) as LoadedSnapshot)
}

function reclaimableSnapshotBytes(snapshot: LoadedSnapshot): bigint | undefined {
	const paths = new Set([
		snapshot.directory,
		path.join(snapshot.directory, "manifest.json"),
		path.join(snapshot.directory, "tree"),
		path.join(snapshot.directory, "protected"),
	])
	for (const entry of snapshot.manifest.entries) {
		if (entry.kind !== "excluded") paths.add(storedSnapshotPath(snapshot.directory, entry))
	}
	let total = 0n
	for (const pathname of paths) {
		const size = readApfsPrivateSize(pathname)
		if (!size.ok) return undefined
		total += size.value
	}
	return total
}

export function verifySnapshot(snapshot: LoadedSnapshot): Result<undefined, SnapshotHistoryError> {
	return verifySnapshotEntries(snapshot, snapshot.manifest.entries)
}

export function verifySnapshotEntries(
	snapshot: LoadedSnapshot,
	entries: ReadonlyArray<SnapshotManifest["entries"][number]>,
): Result<undefined, SnapshotHistoryError> {
	for (const entry of entries) {
		if (entry.kind === "excluded") continue
		const storedPath = storedSnapshotPath(snapshot.directory, entry)
		let stat: fs.Stats
		try {
			stat = fs.lstatSync(storedPath)
		} catch {
			return err({ kind: "stored-entry-mismatch", path: storedPath, expected: entry.kind })
		}
		if (
			entry.kind === "directory" &&
			(!stat.isDirectory() || (stat.mode & 0o7777) !== entry.mode || !sameTimestamp(stat.mtimeMs, entry.mtimeMs))
		) {
			return err({
				kind: "stored-entry-mismatch",
				path: storedPath,
				expected: "directory with recorded mode and modification time",
			})
		}
		if (
			entry.kind === "file" &&
			(!stat.isFile() ||
				stat.size !== entry.size ||
				(stat.mode & 0o7777) !== entry.mode ||
				!sameTimestamp(stat.mtimeMs, entry.mtimeMs))
		) {
			return err({
				kind: "stored-entry-mismatch",
				path: storedPath,
				expected: `file of ${entry.size} bytes with recorded mode and modification time`,
			})
		}
		if (entry.kind === "symlink") {
			if (!stat.isSymbolicLink()) {
				return err({ kind: "stored-entry-mismatch", path: storedPath, expected: "symlink" })
			}
			try {
				if (fs.readlinkSync(storedPath) !== entry.target) {
					return err({ kind: "stored-entry-mismatch", path: storedPath, expected: `symlink to ${entry.target}` })
				}
			} catch (cause) {
				return ioError("read-stored-symlink", storedPath, cause)
			}
		}
	}
	return ok(undefined)
}

function assertNever(value: never): never {
	throw new TypeError(`unhandled snapshot history access: ${JSON.stringify(value)}`)
}

function sameTimestamp(actual: number, expected: number): boolean {
	return Math.abs(actual - expected) < 0.001
}

function ioError(operation: string, targetPath: string, cause: unknown): Result<never, SnapshotHistoryError> {
	return err({
		kind: "io",
		operation,
		path: targetPath,
		message: cause instanceof Error ? cause.message : String(cause),
	})
}

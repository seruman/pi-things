import * as fs from "node:fs"
import * as path from "node:path"
import { createTwoFilesPatch } from "diff"
import { isCanonicalPathWithin } from "./canonical-path"
import { type RestoreScope, describeRestorePlan, executeRestore, planRestore } from "./restore"
import { type Result, err, ok } from "./result"
import {
	type RelativeSnapshotPath,
	type SnapshotError,
	type SnapshotPlanEntry,
	type SnapshotStore,
	createSnapshot,
	garbageCollectSnapshots,
	observeWorkspace,
	observeWorkspacePaths,
} from "./snapshot"
import { SNAPSHOT_USAGE, type SnapshotCommand } from "./snapshot-cli"
import {
	type LoadedSnapshot,
	type SnapshotHistoryAccess,
	type SnapshotHistoryError,
	listSnapshots,
	loadSnapshot,
	verifySnapshot,
} from "./snapshot-history"

export type SnapshotCommandAuthority = { readonly kind: "sandboxed" } | { readonly kind: "direct-user" }

export type SnapshotCommandRunError =
	| { readonly kind: "snapshot"; readonly cause: SnapshotError }
	| { readonly kind: "history"; readonly cause: SnapshotHistoryError }
	| { readonly kind: "restore"; readonly message: string }
	| { readonly kind: "path-not-found"; readonly path: string }
	| { readonly kind: "binary-content"; readonly path: string }
	| { readonly kind: "export-destination"; readonly path: string; readonly message: string }
	| { readonly kind: "io"; readonly operation: string; readonly path: string; readonly message: string }

export function runSnapshotCommand(
	store: SnapshotStore,
	command: SnapshotCommand,
	authority: SnapshotCommandAuthority,
): Result<string, SnapshotCommandRunError> {
	const historyAccess = historyAccessFor(authority)
	switch (command.kind) {
		case "help":
			return ok(SNAPSHOT_USAGE)
		case "list": {
			const listed = listSnapshots(store, historyAccess)
			if (!listed.ok) return err({ kind: "history", cause: listed.error })
			return ok(
				listed.value
					.map((snapshot) => `${snapshot.id}\t${snapshot.createdAt}\t${snapshot.entryCount}\t${snapshot.workspace}`)
					.join("\n"),
			)
		}
		case "create": {
			const created = createSnapshot(store)
			return created.ok ? ok(created.value.id) : err({ kind: "snapshot", cause: created.error })
		}
		case "verify": {
			const loaded = loadSnapshot(store, command.id, historyAccess)
			if (!loaded.ok) return err({ kind: "history", cause: loaded.error })
			const verified = verifySnapshot(loaded.value)
			return verified.ok ? ok(`${command.id}\tverified`) : err({ kind: "history", cause: verified.error })
		}
		case "show": {
			const loaded = loadSnapshot(store, command.id, historyAccess)
			if (!loaded.ok) return err({ kind: "history", cause: loaded.error })
			const entry = loaded.value.manifest.entries.find((candidate) => candidate.path === command.path)
			if (!entry) return err({ kind: "path-not-found", path: command.path })
			if (entry.kind !== "file") return ok(JSON.stringify(entry, null, 2))
			const storageRoot = entry.storage.kind === "protected" ? "protected" : "tree"
			const storedPath = path.join(loaded.value.directory, storageRoot, entry.path)
			try {
				const content = fs.readFileSync(storedPath)
				if (content.includes(0)) return err({ kind: "binary-content", path: command.path })
				try {
					return ok(new TextDecoder("utf-8", { fatal: true }).decode(content))
				} catch {
					return err({ kind: "binary-content", path: command.path })
				}
			} catch (cause) {
				return ioError("show", storedPath, cause)
			}
		}
		case "diff":
			return diffSnapshot(store, command.id, command.scope, historyAccess)
		case "restore": {
			const loaded = loadSnapshot(store, command.id, historyAccess)
			if (!loaded.ok) return err({ kind: "history", cause: loaded.error })
			const planned = planRestore(store, loaded.value, command.scope)
			if (!planned.ok) return err({ kind: "restore", message: JSON.stringify(planned.error) })
			if (command.execution === "dry-run") return ok(describeRestorePlan(planned.value))
			let redoId: string | undefined
			switch (authority.kind) {
				case "sandboxed":
					break
				case "direct-user": {
					const redo = createSnapshot(store, { preserve: command.id })
					if (!redo.ok) return err({ kind: "snapshot", cause: redo.error })
					redoId = redo.value.id
					break
				}
				default:
					assertNever(authority)
			}
			const restored = executeRestore(planned.value)
			if (!restored.ok) return err({ kind: "restore", message: JSON.stringify(restored.error) })
			return ok(redoId === undefined ? `${command.id}\trestored` : `${command.id}\trestored\n${redoId}\tredo`)
		}
		case "export":
			return exportSnapshot(store, command.id, command.destination, historyAccess)
		case "gc": {
			const collected = garbageCollectSnapshots(store)
			return collected.ok ? ok("gc complete") : err({ kind: "snapshot", cause: collected.error })
		}
	}
}

function historyAccessFor(authority: SnapshotCommandAuthority): SnapshotHistoryAccess {
	switch (authority.kind) {
		case "sandboxed":
			return { kind: "immutable-store" }
		case "direct-user":
			return { kind: "verify-policy" }
		default:
			return assertNever(authority)
	}
}

function assertNever(value: never): never {
	throw new TypeError(`unhandled snapshot command authority: ${JSON.stringify(value)}`)
}

function diffSnapshot(
	store: SnapshotStore,
	id: Parameters<typeof loadSnapshot>[1],
	scope: RestoreScope,
	historyAccess: SnapshotHistoryAccess,
): Result<string, SnapshotCommandRunError> {
	const loaded = loadSnapshot(store, id, historyAccess)
	if (!loaded.ok) return err({ kind: "history", cause: loaded.error })
	const live =
		scope.kind === "all"
			? observeWorkspace({ workspaceRoot: store.workspaceRoot, protection: store.protection })
			: observeWorkspacePaths({
					workspaceRoot: store.workspaceRoot,
					protection: store.protection,
					paths: scope.paths,
				})
	if (!live.ok) return err({ kind: "snapshot", cause: live.error })
	const snapshotEntries = new Map(loaded.value.manifest.entries.map((entry) => [entry.path, entry]))
	const liveEntries = new Map(live.value.entries.map((entry) => [entry.path, entry]))
	const nonComparable = new Map(live.value.nonComparable.map((entry) => [entry.path, entry]))
	const candidatePaths = [...new Set([...snapshotEntries.keys(), ...liveEntries.keys(), ...nonComparable.keys()])]
	const paths = candidatePaths
		.filter(
			(relativePath) =>
				scope.kind === "all" ||
				scope.paths.some((selected) => relativePath === selected || relativePath.startsWith(`${selected}${path.sep}`)),
		)
		.sort()
	const changes: string[] = []
	for (const relativePath of paths) {
		const unsupported = nonComparable.get(relativePath)
		if (unsupported !== undefined) {
			changes.push(`non-comparable\t${relativePath}\t${unsupported.entryType}`)
			continue
		}
		const before = snapshotEntries.get(relativePath)
		const after = liveEntries.get(relativePath)
		if (before?.kind === "excluded" || after?.kind === "excluded") {
			changes.push(`excluded\t${relativePath}`)
			continue
		}
		if (!before) changes.push(`added\t${relativePath}`)
		else if (!after) changes.push(`deleted\t${relativePath}`)
		else if (entryChanged(before, after)) changes.push(`modified\t${relativePath}`)
		else if (before.kind === "file" && after.kind === "file") {
			const storageRoot = before.storage.kind === "protected" ? "protected" : "tree"
			const snapshotPath = path.join(loaded.value.directory, storageRoot, before.path)
			const livePath = path.join(store.workspaceRoot, after.path)
			try {
				if (!fs.readFileSync(snapshotPath).equals(fs.readFileSync(livePath))) {
					changes.push(`modified\t${relativePath}`)
				}
			} catch (cause) {
				return ioError("diff", relativePath, cause)
			}
		}
	}
	if (scope.kind === "selected") {
		for (const selected of scope.paths) {
			const patch = createSelectedTextPatch(
				store,
				loaded.value,
				selected,
				snapshotEntries.get(selected),
				liveEntries.get(selected),
			)
			if (!patch.ok) return patch
			if (patch.value !== undefined) changes.push(patch.value)
		}
	}
	return ok(changes.join("\n"))
}

function createSelectedTextPatch(
	store: SnapshotStore,
	snapshot: LoadedSnapshot,
	relativePath: RelativeSnapshotPath,
	before: SnapshotPlanEntry | undefined,
	after: SnapshotPlanEntry | undefined,
): Result<string | undefined, SnapshotCommandRunError> {
	if (before?.kind !== "file" && after?.kind !== "file") return ok(undefined)
	let beforeBytes = Buffer.alloc(0)
	let afterBytes = Buffer.alloc(0)
	try {
		if (before?.kind === "file") {
			const storageRoot = before.storage.kind === "protected" ? "protected" : "tree"
			beforeBytes = fs.readFileSync(path.join(snapshot.directory, storageRoot, relativePath))
		}
		if (after?.kind === "file") afterBytes = fs.readFileSync(path.join(store.workspaceRoot, relativePath))
	} catch (cause) {
		return ioError("diff-text", relativePath, cause)
	}
	if (beforeBytes.equals(afterBytes)) return ok(undefined)
	const beforeText = decodeDiffText(beforeBytes)
	const afterText = decodeDiffText(afterBytes)
	if (beforeText === undefined || afterText === undefined) return ok(`binary-or-large\t${relativePath}`)
	return ok(
		createTwoFilesPatch(`snapshot/${relativePath}`, `live/${relativePath}`, beforeText, afterText, "snapshot", "live"),
	)
}

function decodeDiffText(content: Buffer): string | undefined {
	if (content.byteLength > 1024 * 1024 || content.includes(0)) return undefined
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(content)
	} catch {
		return undefined
	}
}

function entryChanged(before: SnapshotPlanEntry, after: SnapshotPlanEntry): boolean {
	if (before.kind !== after.kind) return true
	if (before.kind === "file" && after.kind === "file") {
		return before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode
	}
	if (before.kind === "directory" && after.kind === "directory") return before.mode !== after.mode
	if (before.kind === "symlink" && after.kind === "symlink") return before.target !== after.target
	return false
}

function exportSnapshot(
	store: SnapshotStore,
	id: Parameters<typeof loadSnapshot>[1],
	destination: Parameters<typeof isCanonicalPathWithin>[1],
	historyAccess: SnapshotHistoryAccess,
): Result<string, SnapshotCommandRunError> {
	if (
		fs.existsSync(destination) ||
		isCanonicalPathWithin(store.workspaceRoot, destination) ||
		isCanonicalPathWithin(store.projectDirectory, destination)
	) {
		return err({
			kind: "export-destination",
			path: destination,
			message: "destination must not exist or be inside managed roots",
		})
	}
	const loaded = loadSnapshot(store, id, historyAccess)
	if (!loaded.ok) return err({ kind: "history", cause: loaded.error })
	const verified = verifySnapshot(loaded.value)
	if (!verified.ok) return err({ kind: "history", cause: verified.error })
	let created = false
	try {
		fs.mkdirSync(destination, { mode: 0o700 })
		created = true
		const directories: Array<Extract<SnapshotPlanEntry, { kind: "directory" }>> = []
		for (const entry of loaded.value.manifest.entries) {
			if (entry.kind === "excluded") continue
			const target = path.join(destination, entry.path)
			if (entry.kind === "directory") {
				fs.mkdirSync(target, { recursive: true, mode: entry.mode })
				directories.push(entry)
			} else if (entry.kind === "symlink") {
				fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
				fs.symlinkSync(entry.target, target)
			} else {
				const storageRoot = entry.storage.kind === "protected" ? "protected" : "tree"
				fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
				fs.copyFileSync(
					path.join(loaded.value.directory, storageRoot, entry.path),
					target,
					fs.constants.COPYFILE_FICLONE_FORCE,
				)
				fs.chmodSync(target, entry.mode)
				fs.utimesSync(target, entry.mtimeMs / 1000, entry.mtimeMs / 1000)
			}
		}
		for (const directory of directories.reverse()) {
			const target = path.join(destination, directory.path)
			fs.chmodSync(target, directory.mode)
			fs.utimesSync(target, directory.mtimeMs / 1000, directory.mtimeMs / 1000)
		}
		return ok(destination)
	} catch (cause) {
		if (created) fs.rmSync(destination, { recursive: true, force: true })
		return ioError("export", destination, cause)
	}
}

function ioError(operation: string, targetPath: string, cause: unknown): Result<never, SnapshotCommandRunError> {
	return err({
		kind: "io",
		operation,
		path: targetPath,
		message: cause instanceof Error ? cause.message : String(cause),
	})
}

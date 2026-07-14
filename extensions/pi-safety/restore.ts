import { randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { type CanonicalPath, parseCanonicalPath } from "./canonical-path"
import { type Result, err, ok } from "./result"
import {
	type RelativeSnapshotPath,
	type SnapshotError,
	type SnapshotPlanEntry,
	type SnapshotStore,
	isExcludedSnapshotPath,
	observeWorkspacePaths,
	parseRelativeSnapshotPath,
	planSnapshot,
	storedSnapshotPath,
} from "./snapshot"
import { type LoadedSnapshot, type SnapshotHistoryError, verifySnapshotEntries } from "./snapshot-history"

const restorePlanBrand: unique symbol = Symbol("RestorePlan")
const selectedRestoreScopeBrand: unique symbol = Symbol("SelectedRestoreScope")

export type RestoreScope =
	| { readonly kind: "all" }
	| {
			readonly kind: "selected"
			readonly paths: readonly [RelativeSnapshotPath, ...RelativeSnapshotPath[]]
			readonly [selectedRestoreScopeBrand]: true
	  }

type RestoreAction =
	| { readonly kind: "delete"; readonly path: RelativeSnapshotPath }
	| { readonly kind: "directory"; readonly entry: Extract<SnapshotPlanEntry, { kind: "directory" }> }
	| {
			readonly kind: "file"
			readonly entry: Extract<SnapshotPlanEntry, { kind: "file" }>
			readonly source: CanonicalPath
	  }
	| { readonly kind: "symlink"; readonly entry: Extract<SnapshotPlanEntry, { kind: "symlink" }> }

export interface RestorePlan {
	readonly workspaceRoot: CanonicalPath
	readonly snapshot: LoadedSnapshot
	readonly scope: RestoreScope
	readonly actions: readonly RestoreAction[]
	readonly [restorePlanBrand]: true
}

export type RestoreError =
	| { readonly kind: "invalid-selection"; readonly input: string; readonly message: string }
	| { readonly kind: "excluded-selection"; readonly path: RelativeSnapshotPath }
	| { readonly kind: "snapshot-verification"; readonly cause: SnapshotHistoryError }
	| { readonly kind: "live-tree"; readonly cause: SnapshotError }
	| { readonly kind: "source-path"; readonly path: string; readonly message: string }
	| { readonly kind: "excluded-conflict"; readonly path: RelativeSnapshotPath; readonly excluded: RelativeSnapshotPath }
	| { readonly kind: "io"; readonly operation: string; readonly path: string; readonly message: string }

export function selectedRestoreScope(inputs: readonly string[]): Result<RestoreScope, RestoreError> {
	if (inputs.length === 0)
		return err({ kind: "invalid-selection", input: "", message: "at least one path is required" })
	const paths: RelativeSnapshotPath[] = []
	const seen = new Set<string>()
	for (const input of inputs) {
		const parsed = parseRelativeSnapshotPath(input)
		if (!parsed.ok) return err({ kind: "invalid-selection", input, message: JSON.stringify(parsed.error) })
		if (!seen.has(parsed.value)) {
			seen.add(parsed.value)
			paths.push(parsed.value)
		}
	}
	if (paths.length === 0) return err({ kind: "invalid-selection", input: "", message: "at least one path is required" })
	return ok(
		Object.freeze({
			kind: "selected",
			paths: Object.freeze(paths) as readonly [RelativeSnapshotPath, ...RelativeSnapshotPath[]],
		}) as RestoreScope,
	)
}

export function planRestore(
	store: SnapshotStore,
	snapshot: LoadedSnapshot,
	scope: RestoreScope,
): Result<RestorePlan, RestoreError> {
	if (scope.kind === "selected") {
		const excluded = scope.paths.find((candidate) =>
			isExcludedSnapshotPath(store.filePolicy, store.workspaceRoot, candidate),
		)
		if (excluded !== undefined) return err({ kind: "excluded-selection", path: excluded })
	}
	const targetEntries = snapshot.manifest.entries.filter((entry) => entry.kind !== "excluded")
	const affectedTarget = targetEntries.filter((entry) => isTargetAffected(entry, scope))
	const verified = verifySnapshotEntries(snapshot, affectedTarget)
	if (!verified.ok) return err({ kind: "snapshot-verification", cause: verified.error })
	const live =
		scope.kind === "all"
			? planSnapshot({ workspaceRoot: store.workspaceRoot, filePolicy: store.filePolicy })
			: observeWorkspacePaths({
					workspaceRoot: store.workspaceRoot,
					filePolicy: store.filePolicy,
					paths: scope.paths,
				})
	if (!live.ok) return err({ kind: "live-tree", cause: live.error })
	const unsupported = "nonComparable" in live.value ? live.value.nonComparable[0] : undefined
	if (unsupported !== undefined) {
		return err({
			kind: "live-tree",
			cause: {
				kind: "unsupported-entry",
				path: path.join(store.workspaceRoot, unsupported.path),
				entryType: unsupported.entryType,
			},
		})
	}

	const liveEntries = live.value.entries.filter((entry) => entry.kind !== "excluded")
	const liveExcluded = live.value.entries.filter(
		(entry): entry is Extract<SnapshotPlanEntry, { kind: "excluded" }> => entry.kind === "excluded",
	)
	const targetByPath = new Map(targetEntries.map((entry) => [entry.path, entry]))
	const affectedLive = liveEntries.filter((entry) => isPathAffected(entry.path, scope))

	const deletionCandidates: RelativeSnapshotPath[] = []
	for (const entry of affectedLive) {
		const target = targetByPath.get(entry.path)
		if (!target || target.kind !== entry.kind || target.kind === "file" || target.kind === "symlink") {
			const excluded = liveExcluded.find((candidate) => isSameOrDescendant(candidate.path, entry.path))
			if (excluded) {
				if (target && target.kind !== "directory") {
					return err({ kind: "excluded-conflict", path: entry.path, excluded: excluded.path })
				}
				continue
			}
			deletionCandidates.push(entry.path)
		}
	}
	const deletions = deletionCandidates
		.filter(
			(candidate) => !deletionCandidates.some((other) => other !== candidate && isSameOrDescendant(candidate, other)),
		)
		.sort((left, right) => depth(right) - depth(left))
		.map((relativePath): RestoreAction => ({ kind: "delete", path: relativePath }))

	const creations: RestoreAction[] = []
	for (const entry of affectedTarget) {
		if (entry.kind === "directory") {
			creations.push({ kind: "directory", entry })
		} else if (entry.kind === "symlink") {
			creations.push({ kind: "symlink", entry })
		} else if (entry.kind === "file") {
			const sourcePath = storedSnapshotPath(snapshot.directory, entry)
			const source = parseCanonicalPath(sourcePath)
			if (!source.ok) return err({ kind: "source-path", path: sourcePath, message: JSON.stringify(source.error) })
			creations.push({ kind: "file", entry, source: source.value })
		}
	}
	return ok(
		Object.freeze({
			workspaceRoot: store.workspaceRoot,
			snapshot,
			scope,
			actions: Object.freeze([...deletions, ...creations].map((action) => Object.freeze(action))),
		}) as RestorePlan,
	)
}

export function describeRestorePlan(plan: RestorePlan): string {
	return plan.actions
		.map((action) => {
			const relativePath = action.kind === "delete" ? action.path : action.entry.path
			return `${action.kind}\t${relativePath}`
		})
		.join("\n")
}

export function executeRestore(plan: RestorePlan): Result<undefined, RestoreError> {
	const directories: Array<Extract<RestoreAction, { kind: "directory" }>> = []
	for (const action of plan.actions) {
		const destination = path.join(plan.workspaceRoot, action.kind === "delete" ? action.path : action.entry.path)
		try {
			switch (action.kind) {
				case "delete":
					fs.rmSync(destination, { recursive: true, force: true })
					break
				case "directory":
					fs.mkdirSync(destination, { recursive: true, mode: action.entry.mode })
					directories.push(action)
					break
				case "symlink":
					fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
					fs.symlinkSync(action.entry.target, destination)
					break
				case "file": {
					fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
					const temporary = `${destination}.pi-safety-restore-${randomBytes(8).toString("hex")}`
					try {
						fs.copyFileSync(action.source, temporary, fs.constants.COPYFILE_FICLONE_FORCE)
						fs.chmodSync(temporary, action.entry.mode)
						fs.utimesSync(temporary, action.entry.mtimeMs / 1000, action.entry.mtimeMs / 1000)
						fs.renameSync(temporary, destination)
					} finally {
						fs.rmSync(temporary, { force: true })
					}
					break
				}
			}
		} catch (cause) {
			return err({
				kind: "io",
				operation: action.kind,
				path: destination,
				message: cause instanceof Error ? cause.message : String(cause),
			})
		}
	}
	for (const action of directories.reverse()) {
		const destination = path.join(plan.workspaceRoot, action.entry.path)
		try {
			fs.chmodSync(destination, action.entry.mode)
			fs.utimesSync(destination, action.entry.mtimeMs / 1000, action.entry.mtimeMs / 1000)
		} catch (cause) {
			return err({
				kind: "io",
				operation: "directory-metadata",
				path: destination,
				message: cause instanceof Error ? cause.message : String(cause),
			})
		}
	}
	return ok(undefined)
}

function isTargetAffected(entry: SnapshotPlanEntry, scope: RestoreScope): boolean {
	if (scope.kind === "all") return true
	return (
		isPathAffected(entry.path, scope) ||
		(entry.kind === "directory" && scope.paths.some((selected) => isSameOrDescendant(selected, entry.path)))
	)
}

function isPathAffected(relativePath: RelativeSnapshotPath, scope: RestoreScope): boolean {
	return scope.kind === "all" || scope.paths.some((selected) => isSameOrDescendant(relativePath, selected))
}

function isSameOrDescendant(candidate: RelativeSnapshotPath, ancestor: RelativeSnapshotPath): boolean {
	return candidate === ancestor || candidate.startsWith(`${ancestor}${path.sep}`)
}

function depth(relativePath: RelativeSnapshotPath): number {
	return relativePath.split(path.sep).length
}

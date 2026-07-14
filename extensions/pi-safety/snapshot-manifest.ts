import * as path from "node:path"
import { type CanonicalPath, parseCanonicalPath } from "./canonical-path"
import { type Result, err, ok } from "./result"
import {
	type RelativeSnapshotPath,
	type SnapshotId,
	type SnapshotPlanEntry,
	isExcludedSnapshotPath,
	parseRelativeSnapshotPath,
	parseSnapshotId,
} from "./snapshot"

const snapshotManifestBrand: unique symbol = Symbol("SnapshotManifest")

export interface SnapshotManifest {
	readonly version: 1
	readonly id: SnapshotId
	readonly createdAt: string
	readonly workspace: CanonicalPath
	readonly entries: readonly SnapshotPlanEntry[]
	readonly [snapshotManifestBrand]: true
}

export type SnapshotManifestError =
	| { readonly kind: "invalid-manifest"; readonly field: string; readonly message: string }
	| { readonly kind: "invalid-entry"; readonly index: number; readonly message: string }
	| { readonly kind: "duplicate-path"; readonly path: RelativeSnapshotPath }
	| { readonly kind: "path-conflict"; readonly path: RelativeSnapshotPath; readonly ancestor: RelativeSnapshotPath }

export function parseSnapshotManifest(input: unknown): Result<SnapshotManifest, SnapshotManifestError> {
	if (!isRecord(input)) return invalidManifest("manifest", "expected an object")
	if (input.version !== 1) return invalidManifest("version", "expected version 1")
	if (typeof input.id !== "string") return invalidManifest("id", "expected a string")
	const id = parseSnapshotId(input.id)
	if (!id.ok) return invalidManifest("id", "invalid snapshot identifier")
	if (typeof input.createdAt !== "string" || !isCanonicalIsoTimestamp(input.createdAt)) {
		return invalidManifest("createdAt", "expected a canonical ISO timestamp")
	}
	if (input.createdAt.replace(/[^0-9]/g, "") !== input.id.slice(0, 17)) {
		return invalidManifest("createdAt", "timestamp does not match snapshot identifier")
	}
	if (typeof input.workspace !== "string") return invalidManifest("workspace", "expected a string")
	const workspace = parseCanonicalPath(input.workspace)
	if (!workspace.ok) return invalidManifest("workspace", JSON.stringify(workspace.error))
	if (!Array.isArray(input.entries)) return invalidManifest("entries", "expected an array")

	const entries: SnapshotPlanEntry[] = []
	const paths = new Map<string, SnapshotPlanEntry>()
	for (const [index, rawEntry] of input.entries.entries()) {
		const parsed = parseEntry(rawEntry, index)
		if (!parsed.ok) return parsed
		if (paths.has(parsed.value.path)) return err({ kind: "duplicate-path", path: parsed.value.path })
		paths.set(parsed.value.path, parsed.value)
		entries.push(Object.freeze(parsed.value))
	}
	for (const entry of entries) {
		let ancestor = path.dirname(entry.path)
		while (ancestor !== ".") {
			const ancestorEntry = paths.get(ancestor)
			if (ancestorEntry && ancestorEntry.kind !== "directory") {
				const parsedAncestor = parseRelativeSnapshotPath(ancestor)
				if (!parsedAncestor.ok) return invalidManifest("entries", "failed to parse a normalized ancestor")
				return err({ kind: "path-conflict", path: entry.path, ancestor: parsedAncestor.value })
			}
			ancestor = path.dirname(ancestor)
		}
	}
	return ok(
		Object.freeze({
			version: 1,
			id: id.value,
			createdAt: input.createdAt,
			workspace: workspace.value,
			entries: Object.freeze(entries),
		}) as SnapshotManifest,
	)
}

function parseEntry(input: unknown, index: number): Result<SnapshotPlanEntry, SnapshotManifestError> {
	if (!isRecord(input) || typeof input.kind !== "string" || typeof input.path !== "string") {
		return invalidEntry(index, "expected an entry object with kind and path")
	}
	const parsedPath = parseRelativeSnapshotPath(input.path)
	if (!parsedPath.ok) return invalidEntry(index, "invalid relative path")
	const relativePath = parsedPath.value
	if (input.kind === "excluded") {
		if (!hasExactKeys(input, ["kind", "path", "reason"]) || input.reason !== "generated-component") {
			return invalidEntry(index, "invalid excluded entry")
		}
		if (!isExcludedSnapshotPath(relativePath)) return invalidEntry(index, "excluded path has no excluded component")
		return ok({ kind: "excluded", path: relativePath, reason: "generated-component" })
	}
	if (isExcludedSnapshotPath(relativePath))
		return invalidEntry(index, "non-excluded entry contains an excluded component")
	if (input.kind === "directory") {
		if (!hasExactKeys(input, ["kind", "path", "mode", "mtimeMs"]) || !isMode(input.mode) || !isTime(input.mtimeMs)) {
			return invalidEntry(index, "invalid directory entry")
		}
		return ok({ kind: "directory", path: relativePath, mode: input.mode, mtimeMs: input.mtimeMs })
	}
	if (input.kind === "file") {
		if (
			!hasExactKeys(input, ["kind", "path", "mode", "mtimeMs", "size", "storage"]) ||
			!isMode(input.mode) ||
			!isTime(input.mtimeMs) ||
			!isNonnegativeSafeInteger(input.size) ||
			!isStorage(input.storage)
		) {
			return invalidEntry(index, "invalid file entry")
		}
		return ok({
			kind: "file",
			path: relativePath,
			mode: input.mode,
			mtimeMs: input.mtimeMs,
			size: input.size,
			storage: { kind: input.storage.kind },
		})
	}
	if (input.kind === "symlink") {
		if (
			!hasExactKeys(input, ["kind", "path", "target"]) ||
			typeof input.target !== "string" ||
			input.target.includes("\0")
		) {
			return invalidEntry(index, "invalid symlink entry")
		}
		return ok({ kind: "symlink", path: relativePath, target: input.target })
	}
	return invalidEntry(index, `unknown entry kind ${input.kind}`)
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input)
}

function hasExactKeys(input: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(input).sort()
	const expected = [...keys].sort()
	return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isMode(input: unknown): input is number {
	return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 && input <= 0o7777
}

function isNonnegativeSafeInteger(input: unknown): input is number {
	return typeof input === "number" && Number.isSafeInteger(input) && input >= 0
}

function isTime(input: unknown): input is number {
	return typeof input === "number" && Number.isFinite(input) && input >= 0
}

function isStorage(input: unknown): input is { readonly kind: "ordinary" | "protected" } {
	return isRecord(input) && hasExactKeys(input, ["kind"]) && (input.kind === "ordinary" || input.kind === "protected")
}

function isCanonicalIsoTimestamp(input: string): boolean {
	const timestamp = Date.parse(input)
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === input
}

function invalidManifest(field: string, message: string): Result<never, SnapshotManifestError> {
	return err({ kind: "invalid-manifest", field, message })
}

function invalidEntry(index: number, message: string): Result<never, SnapshotManifestError> {
	return err({ kind: "invalid-entry", index, message })
}

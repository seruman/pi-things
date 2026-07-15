import * as path from "node:path"
import { z } from "zod"
import { type CanonicalPath, parseCanonicalPath } from "./canonical-path"
import type { Policy } from "./policy"
import { type Result, err, ok } from "./result"
import {
	type RelativeSnapshotPath,
	type SnapshotId,
	type SnapshotOrigin,
	type SnapshotPlanEntry,
	isExcludedSnapshotPath,
	relativeSnapshotPathSchema,
	snapshotIdSchema,
	snapshotSessionIdSchema,
} from "./snapshot"

const snapshotManifestBrand: unique symbol = Symbol("SnapshotManifest")

export interface SnapshotManifest {
	readonly version: 1 | 2 | 3
	readonly id: SnapshotId
	readonly createdAt: string
	readonly workspace: CanonicalPath
	readonly origin: SnapshotOrigin
	readonly entries: readonly SnapshotPlanEntry[]
	readonly [snapshotManifestBrand]: true
}

export type SnapshotManifestError =
	| { readonly kind: "invalid-manifest"; readonly field: string; readonly message: string }
	| { readonly kind: "invalid-entry"; readonly index: number; readonly message: string }
	| { readonly kind: "duplicate-path"; readonly path: RelativeSnapshotPath }
	| { readonly kind: "path-conflict"; readonly path: RelativeSnapshotPath; readonly ancestor: RelativeSnapshotPath }

const modeSchema = z.number().int().min(0).max(0o7777)
const timeSchema = z.number().finite().nonnegative()
const sizeSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const storageSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("ordinary") }).strict(),
	z.object({ kind: z.literal("protected") }).strict(),
])

const directoryEntrySchema = z
	.object({ kind: z.literal("directory"), path: relativeSnapshotPathSchema, mode: modeSchema, mtimeMs: timeSchema })
	.strict()
const fileEntrySchema = z
	.object({
		kind: z.literal("file"),
		path: relativeSnapshotPathSchema,
		mode: modeSchema,
		mtimeMs: timeSchema,
		size: sizeSchema,
		storage: storageSchema,
	})
	.strict()
const symlinkEntrySchema = z
	.object({
		kind: z.literal("symlink"),
		path: relativeSnapshotPathSchema,
		target: z.string().regex(/^[^\0]*$/u, "target must not contain NUL"),
	})
	.strict()
const legacyExcludedEntrySchema = z
	.object({ kind: z.literal("excluded"), path: relativeSnapshotPathSchema, reason: z.literal("generated-component") })
	.strict()
const policyExcludedEntrySchema = z
	.object({ kind: z.literal("excluded"), path: relativeSnapshotPathSchema, reason: z.literal("policy") })
	.strict()
const legacyEntrySchema = z.discriminatedUnion("kind", [
	legacyExcludedEntrySchema,
	directoryEntrySchema,
	fileEntrySchema,
	symlinkEntrySchema,
])
const currentEntrySchema = z.discriminatedUnion("kind", [
	policyExcludedEntrySchema,
	directoryEntrySchema,
	fileEntrySchema,
	symlinkEntrySchema,
])
const originSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("standalone") }).strict(),
	z.object({ kind: z.literal("pi-session"), sessionId: snapshotSessionIdSchema }).strict(),
])
const manifestFields = {
	id: snapshotIdSchema,
	createdAt: z.string().datetime({ offset: false, precision: 3 }),
	workspace: z.string(),
}
export const snapshotManifestSchema = z.discriminatedUnion("version", [
	z
		.object({
			version: z.literal(1),
			...manifestFields,
			entries: z.array(legacyEntrySchema),
		})
		.strict(),
	z
		.object({
			version: z.literal(2),
			...manifestFields,
			entries: z.array(currentEntrySchema),
		})
		.strict(),
	z
		.object({
			version: z.literal(3),
			...manifestFields,
			origin: originSchema,
			entries: z.array(currentEntrySchema),
		})
		.strict(),
])

export type RawSnapshotManifest = z.infer<typeof snapshotManifestSchema>
type RawManifestEntry = RawSnapshotManifest["entries"][number]

export function parseSnapshotManifest(
	raw: RawSnapshotManifest,
	policy: Policy,
): Result<SnapshotManifest, SnapshotManifestError> {
	if (raw.createdAt.replace(/[^0-9]/g, "") !== raw.id.slice(0, 17)) {
		return invalidManifest("createdAt", "timestamp does not match snapshot identifier")
	}
	const workspace = parseCanonicalPath(raw.workspace)
	if (!workspace.ok) return invalidManifest("workspace", JSON.stringify(workspace.error))
	const origin: SnapshotOrigin = raw.version === 3 ? raw.origin : { kind: "legacy" }

	const entries: SnapshotPlanEntry[] = []
	const paths = new Map<string, SnapshotPlanEntry>()
	for (const [index, rawEntry] of raw.entries.entries()) {
		const parsed = parseEntry(rawEntry, index, policy, workspace.value)
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
				return err({ kind: "path-conflict", path: entry.path, ancestor: ancestorEntry.path })
			}
			ancestor = path.dirname(ancestor)
		}
	}
	return ok(
		Object.freeze({
			version: raw.version,
			id: raw.id,
			createdAt: raw.createdAt,
			workspace: workspace.value,
			origin,
			entries: Object.freeze(entries),
		}) as SnapshotManifest,
	)
}

function parseEntry(
	input: RawManifestEntry,
	index: number,
	policy: Policy,
	workspace: CanonicalPath,
): Result<SnapshotPlanEntry, SnapshotManifestError> {
	if (input.kind === "excluded") {
		if (!isExcludedSnapshotPath(policy, workspace, input.path)) {
			return invalidEntry(index, "excluded path is not excluded by policy")
		}
		return ok({ kind: "excluded", path: input.path, reason: "policy" })
	}
	if (isExcludedSnapshotPath(policy, workspace, input.path)) {
		return invalidEntry(index, "non-excluded entry is excluded by policy")
	}
	if (input.kind === "directory") {
		return ok({ kind: "directory", path: input.path, mode: input.mode, mtimeMs: input.mtimeMs })
	}
	if (input.kind === "file") {
		return ok({
			kind: "file",
			path: input.path,
			mode: input.mode,
			mtimeMs: input.mtimeMs,
			size: input.size,
			storage: input.storage,
		})
	}
	return ok({ kind: "symlink", path: input.path, target: input.target })
}

export function snapshotManifestSchemaError(error: z.ZodError): SnapshotManifestError {
	const issue = error.issues[0]
	if (!issue) return { kind: "invalid-manifest", field: "manifest", message: "invalid manifest" }
	if (issue.path[0] === "entries" && typeof issue.path[1] === "number") {
		return { kind: "invalid-entry", index: issue.path[1], message: issue.message }
	}
	return { kind: "invalid-manifest", field: issue.path.join(".") || "manifest", message: issue.message }
}

function invalidManifest(field: string, message: string): Result<never, SnapshotManifestError> {
	return err({ kind: "invalid-manifest", field, message })
}

function invalidEntry(index: number, message: string): Result<never, SnapshotManifestError> {
	return err({ kind: "invalid-entry", index, message })
}

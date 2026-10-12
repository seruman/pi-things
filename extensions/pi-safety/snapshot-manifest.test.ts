import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import type { JsonValue } from "@earendil-works/pi-ai"
import { createSnapshotPolicy } from "./default-policy"
import type { Policy } from "./policy"
import { type Result, err, unwrap } from "./result"
import {
	type SnapshotManifest,
	type SnapshotManifestError,
	parseSnapshotManifest,
	snapshotManifestSchema,
	snapshotManifestSchemaError,
} from "./snapshot-manifest"
import { canonicalPath } from "./test-domain-values"
import { withTestTempDirectory } from "./test-temp-directory"

function parseManifest(input: JsonValue, policy: Policy): Result<SnapshotManifest, SnapshotManifestError> {
	const decoded = snapshotManifestSchema.safeParse(input)

	return decoded.success ? parseSnapshotManifest(decoded.data, policy) : err(snapshotManifestSchemaError(decoded.error))
}

function validManifest(workspace: string) {
	return {
		version: 1,
		id: "20260713213049840-206bc3b657fa7807",
		createdAt: "2026-07-13T21:30:49.840Z",
		workspace,
		entries: [
			{ kind: "excluded", path: ".git", reason: "generated-component" },
			{ kind: "directory", path: "src", mode: 493, mtimeMs: 1 },
			{
				kind: "file",
				path: "src/index.ts",
				mode: 420,
				mtimeMs: 2,
				size: 3,
				storage: { kind: "ordinary" },
			},
			{ kind: "symlink", path: "link", target: "src/index.ts" },
		],
	} as const satisfies JsonValue
}

test("parses a versioned snapshot manifest into precise entries", () => {
	withTestTempDirectory("manifest-valid-", (root) => {
		const workspace = path.join(root, "workspace")
		fs.mkdirSync(workspace)
		const policy = unwrap(createSnapshotPolicy(canonicalPath(workspace)))
		const parsed = parseManifest(validManifest(workspace), policy)
		assert.equal(parsed.ok, true)

		if (parsed.ok) {
			assert.equal(parsed.value.workspace, canonicalPath(workspace))
			assert.deepEqual(parsed.value.origin, { kind: "legacy" })
			assert.equal(parsed.value.entries[2].kind, "file")
		}

		const legacy = validManifest(workspace)

		const current = {
			...legacy,
			version: 3,
			origin: { kind: "pi-session", sessionId: "019f6277-361d-7f97-9d5b-7db7e0618fe1" },
			entries: legacy.entries.map((entry) => (entry.kind === "excluded" ? { ...entry, reason: "policy" } : entry)),
		}

		const parsedCurrent = parseManifest(current, policy)
		assert.equal(parsedCurrent.ok, true)

		if (parsedCurrent.ok) {
			assert.deepEqual(parsedCurrent.value.origin, {
				kind: "pi-session",
				sessionId: "019f6277-361d-7f97-9d5b-7db7e0618fe1",
			})
		}
	})
})

test("rejects unknown versions, traversal, duplicates, invalid variants, and exclusion conflicts", () => {
	withTestTempDirectory("manifest-invalid-", (root) => {
		const workspace = path.join(root, "workspace")
		fs.mkdirSync(workspace)
		const policy = unwrap(createSnapshotPolicy(canonicalPath(workspace)))

		const cases = [
			{ ...validManifest(workspace), version: 4 },
			{ ...validManifest(workspace), version: 3 },
			{
				...validManifest(workspace),
				version: 3,
				origin: { kind: "pi-session", sessionId: "not-a-session" },
				entries: validManifest(workspace).entries.map((entry) =>
					entry.kind === "excluded" ? { ...entry, reason: "policy" } : entry,
				),
			},
			{ ...validManifest(workspace), createdAt: "2026-07-13T21:30:49.841Z" },
			{
				...validManifest(workspace),
				entries: [{ kind: "file", path: "../escape", mode: 420, mtimeMs: 1, size: 1, storage: { kind: "ordinary" } }],
			},
			{
				...validManifest(workspace),
				entries: [
					{ kind: "directory", path: "same", mode: 493, mtimeMs: 1 },
					{ kind: "symlink", path: "same", target: "x" },
				],
			},
			{
				...validManifest(workspace),
				entries: [{ kind: "directory", path: "src", mode: 493, mtimeMs: 1, storage: { kind: "ordinary" } }],
			},
			{
				...validManifest(workspace),
				entries: [{ kind: "file", path: "src", mode: 420, mtimeMs: 1, size: 1, storage: { kind: "unknown" } }],
			},
			{
				...validManifest(workspace),
				entries: [
					{ kind: "file", path: "node_modules/pkg.js", mode: 420, mtimeMs: 1, size: 1, storage: { kind: "ordinary" } },
				],
			},
			{
				...validManifest(workspace),
				entries: [
					{ kind: "file", path: "parent", mode: 420, mtimeMs: 1, size: 1, storage: { kind: "ordinary" } },
					{ kind: "file", path: "parent/child", mode: 420, mtimeMs: 1, size: 1, storage: { kind: "ordinary" } },
				],
			},
		] as const satisfies readonly JsonValue[]

		for (const input of cases) assert.equal(parseManifest(input, policy).ok, false)
	})
})

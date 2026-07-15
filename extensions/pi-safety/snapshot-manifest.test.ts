import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { createSnapshotFilePolicy } from "./default-rules"
import type { FilePolicy } from "./file-policy"
import { type Result, err, unwrap } from "./result"
import {
	type SnapshotManifest,
	type SnapshotManifestError,
	parseSnapshotManifest,
	snapshotManifestSchema,
	snapshotManifestSchemaError,
} from "./snapshot-manifest"
import { canonicalPath, testFilePolicy } from "./test-domain-values"
import { withTestTempDirectory } from "./test-temp-directory"

function parseManifest(input: unknown, policy: FilePolicy): Result<SnapshotManifest, SnapshotManifestError> {
	const decoded = snapshotManifestSchema.safeParse(input)
	return decoded.success ? parseSnapshotManifest(decoded.data, policy) : err(snapshotManifestSchemaError(decoded.error))
}

function validManifest(workspace: string): Record<string, unknown> {
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
	}
}

test("parses a versioned snapshot manifest into precise entries", () => {
	withTestTempDirectory("manifest-valid-", (root) => {
		const workspace = path.join(root, "workspace")
		fs.mkdirSync(workspace)
		const policy = unwrap(createSnapshotFilePolicy(canonicalPath(workspace)))
		const parsed = parseManifest(validManifest(workspace), policy)
		assert.equal(parsed.ok, true)
		if (parsed.ok) {
			assert.equal(parsed.value.workspace, canonicalPath(workspace))
			assert.deepEqual(parsed.value.origin, { kind: "legacy" })
			assert.equal(parsed.value.entries[2].kind, "file")
		}

		const current = validManifest(workspace)
		current.version = 3
		current.origin = { kind: "pi-session", sessionId: "019f6277-361d-7f97-9d5b-7db7e0618fe1" }
		current.entries = (current.entries as Array<Record<string, unknown>>).map((entry) =>
			entry.kind === "excluded" ? { ...entry, reason: "policy" } : entry,
		)
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

test("hostile generated manifest values never escape parsed domain invariants", () => {
	let state = 0x51f15e
	const next = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0
		return state
	}
	const generated = (depth: number): unknown => {
		if (depth === 0) return [null, next(), `value-${next()}\0`, next() % 2 === 0][next() % 4]
		switch (next() % 4) {
			case 0:
				return Array.from({ length: next() % 5 }, () => generated(depth - 1))
			case 1:
				return { [`key-${next()}`]: generated(depth - 1), kind: ["file", "directory", "symlink"][next() % 3] }
			case 2:
				return `../${next()}/\"\n`
			default:
				return next()
		}
	}
	const policy = testFilePolicy("/tmp", "/tmp")
	for (let index = 0; index < 500; index += 1) {
		const parsed = parseManifest(generated(3), policy)
		if (!parsed.ok) continue
		assert.ok(parsed.value.version === 1 || parsed.value.version === 2 || parsed.value.version === 3)
		assert.equal(new Set(parsed.value.entries.map((entry) => entry.path)).size, parsed.value.entries.length)
		for (const entry of parsed.value.entries) {
			assert.equal(path.isAbsolute(entry.path), false)
			assert.equal(
				entry.path.split(path.sep).some((component) => component === "." || component === ".."),
				false,
			)
		}
	}
})

test("rejects unknown versions, traversal, duplicates, invalid variants, and exclusion conflicts", () => {
	withTestTempDirectory("manifest-invalid-", (root) => {
		const workspace = path.join(root, "workspace")
		fs.mkdirSync(workspace)
		const policy = unwrap(createSnapshotFilePolicy(canonicalPath(workspace)))
		const cases = [
			{ ...validManifest(workspace), version: 4 },
			{ ...validManifest(workspace), version: 3 },
			{
				...validManifest(workspace),
				version: 3,
				origin: { kind: "pi-session", sessionId: "not-a-session" },
				entries: (validManifest(workspace).entries as Array<Record<string, unknown>>).map((entry) =>
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
		]
		for (const input of cases) assert.equal(parseManifest(input, policy).ok, false)
	})
})

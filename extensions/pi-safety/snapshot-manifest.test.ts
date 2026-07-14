import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { parseSnapshotManifest } from "./snapshot-manifest"
import { canonicalPath } from "./test-domain-values"
import { withTestTempDirectory } from "./test-temp-directory"

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
		const parsed = parseSnapshotManifest(validManifest(workspace))
		assert.equal(parsed.ok, true)
		if (parsed.ok) {
			assert.equal(parsed.value.workspace, canonicalPath(workspace))
			assert.equal(parsed.value.entries[2].kind, "file")
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
	for (let index = 0; index < 500; index += 1) {
		const parsed = parseSnapshotManifest(generated(3))
		if (!parsed.ok) continue
		assert.equal(parsed.value.version, 1)
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
		const cases = [
			{ ...validManifest(workspace), version: 2 },
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
		for (const input of cases) assert.equal(parseSnapshotManifest(input).ok, false)
	})
})

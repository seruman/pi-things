import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { unwrap } from "./result"
import { createSnapshot, createSnapshotStore } from "./snapshot"
import { listSnapshots, loadSnapshot, verifySnapshot } from "./snapshot-history"
import { canonicalPath, testPolicy } from "./test-domain-values"
import { withTestTempDirectory } from "./test-temp-directory"

function fixture(root: string) {
	const workspace = path.join(root, "workspace")
	const state = path.join(root, "state")
	fs.mkdirSync(workspace)
	fs.mkdirSync(state)
	fs.writeFileSync(path.join(workspace, "file.txt"), "content")
	const store = unwrap(
		createSnapshotStore({
			workspaceRoot: canonicalPath(workspace),
			stateRoot: canonicalPath(state),
			policy: testPolicy(workspace, state),
		}),
	)
	const published = unwrap(createSnapshot(store))
	return { workspace, store, published }
}

test("lists, loads, and verifies published snapshots through parsed manifests", () => {
	withTestTempDirectory("snapshot-history-", (root) => {
		const value = fixture(root)
		const listed = unwrap(listSnapshots(value.store))
		assert.equal(listed.length, 1)
		assert.equal(listed[0].id, value.published.id)
		assert.deepEqual(listed[0].origin, { kind: "standalone" })
		assert.ok(listed[0].reclaimableBytes !== undefined && listed[0].reclaimableBytes > 0n)
		const loaded = unwrap(loadSnapshot(value.store, value.published.id))
		assert.equal(loaded.manifest.workspace, value.store.workspaceRoot)
		assert.deepEqual(verifySnapshot(loaded), { ok: true, value: undefined })
	})
})

test("verification rejects stored metadata changes", () => {
	withTestTempDirectory("snapshot-history-metadata-", (root) => {
		const value = fixture(root)
		const loaded = unwrap(loadSnapshot(value.store, value.published.id))
		const stored = path.join(value.published.directory, "tree", "file.txt")
		const original = fs.statSync(stored)
		fs.utimesSync(stored, original.atimeMs / 1000, original.mtimeMs / 1000 + 10)
		const verified = verifySnapshot(loaded)
		assert.equal(verified.ok, false)
		if (!verified.ok) assert.equal(verified.error.kind, "stored-entry-mismatch")
	})
})

test("rejects manifest identity mismatches and missing stored entries", () => {
	withTestTempDirectory("snapshot-history-invalid-", (root) => {
		const value = fixture(root)
		const manifestPath = path.join(value.published.directory, "manifest.json")
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
		manifest.id = "20260713213049840-206bc3b657fa7807"
		fs.writeFileSync(manifestPath, JSON.stringify(manifest))
		assert.equal(loadSnapshot(value.store, value.published.id).ok, false)

		manifest.id = value.published.id
		const fileEntry = manifest.entries.find((entry: { kind: string }) => entry.kind === "file")
		if (!fileEntry) throw new Error("test manifest file entry missing")
		fileEntry.storage = { kind: "protected" }
		fs.writeFileSync(manifestPath, JSON.stringify(manifest))
		const storageMismatch = loadSnapshot(value.store, value.published.id)
		assert.equal(storageMismatch.ok, false)
		if (!storageMismatch.ok) assert.equal(storageMismatch.error.kind, "storage-classification-mismatch")

		fileEntry.storage = { kind: "ordinary" }
		fs.writeFileSync(manifestPath, JSON.stringify(manifest))
		const loaded = unwrap(loadSnapshot(value.store, value.published.id))
		fs.rmSync(path.join(value.published.directory, "tree", "file.txt"))
		const verified = verifySnapshot(loaded)
		assert.equal(verified.ok, false)
		if (!verified.ok) assert.equal(verified.error.kind, "stored-entry-mismatch")
	})
})

import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { createSnapshotPolicy } from "./default-policy"
import { executeRestore, planRestore, selectedRestoreScope } from "./restore"
import { unwrap } from "./result"
import { createSnapshot, createSnapshotStore } from "./snapshot"
import { loadSnapshot } from "./snapshot-history"
import { canonicalPath, pathPattern, testPolicy } from "./test-domain-values"
import { withTestTempDirectory } from "./test-temp-directory"

function fixture(root: string) {
	const workspace = path.join(root, "workspace")
	const state = path.join(root, "state")
	fs.mkdirSync(workspace)
	fs.mkdirSync(state)
	fs.mkdirSync(path.join(workspace, "directory"))
	fs.writeFileSync(path.join(workspace, "directory", "modified.txt"), "before")
	fs.writeFileSync(path.join(workspace, "deleted.txt"), "restore-me")
	fs.writeFileSync(path.join(workspace, "type-change"), "was-file")
	fs.symlinkSync("deleted.txt", path.join(workspace, "link"))
	fs.mkdirSync(path.join(workspace, "node_modules"))
	fs.writeFileSync(path.join(workspace, "node_modules", "preserved.js"), "before-generated")
	const workspaceRoot = canonicalPath(workspace)
	const store = unwrap(
		createSnapshotStore({
			workspaceRoot,
			stateRoot: canonicalPath(state),
			policy: unwrap(createSnapshotPolicy(workspaceRoot)),
		}),
	)
	const published = unwrap(createSnapshot(store))
	const loaded = unwrap(loadSnapshot(store, published.id))
	return { workspace, store, loaded }
}

test("full restore executes an immutable plan while preserving excluded paths", () => {
	withTestTempDirectory("restore-full-", (root) => {
		const value = fixture(root)
		fs.writeFileSync(path.join(value.workspace, "directory", "modified.txt"), "after")
		fs.rmSync(path.join(value.workspace, "deleted.txt"))
		fs.rmSync(path.join(value.workspace, "type-change"))
		fs.mkdirSync(path.join(value.workspace, "type-change"))
		fs.writeFileSync(path.join(value.workspace, "added.txt"), "delete-me")
		fs.writeFileSync(path.join(value.workspace, "node_modules", "preserved.js"), "after-generated")

		const plan = unwrap(planRestore(value.store, value.loaded, { kind: "all" }))
		unwrap(executeRestore(plan))
		assert.equal(fs.readFileSync(path.join(value.workspace, "directory", "modified.txt"), "utf8"), "before")
		assert.equal(fs.readFileSync(path.join(value.workspace, "deleted.txt"), "utf8"), "restore-me")
		assert.equal(fs.readFileSync(path.join(value.workspace, "type-change"), "utf8"), "was-file")
		assert.equal(fs.readlinkSync(path.join(value.workspace, "link")), "deleted.txt")
		assert.equal(fs.existsSync(path.join(value.workspace, "added.txt")), false)
		assert.equal(fs.readFileSync(path.join(value.workspace, "node_modules", "preserved.js"), "utf8"), "after-generated")
	})
})

test("selected restore changes only selected paths and treats snapshot absence as deletion", () => {
	withTestTempDirectory("restore-selected-", (root) => {
		const value = fixture(root)
		fs.writeFileSync(path.join(value.workspace, "directory", "modified.txt"), "after")
		fs.writeFileSync(path.join(value.workspace, "deleted.txt"), "after")
		fs.writeFileSync(path.join(value.workspace, "added.txt"), "delete-me")
		const scope = unwrap(selectedRestoreScope(["directory/modified.txt", "added.txt"]))
		const plan = unwrap(planRestore(value.store, value.loaded, scope))
		unwrap(executeRestore(plan))
		assert.equal(fs.readFileSync(path.join(value.workspace, "directory", "modified.txt"), "utf8"), "before")
		assert.equal(fs.readFileSync(path.join(value.workspace, "deleted.txt"), "utf8"), "after")
		assert.equal(fs.existsSync(path.join(value.workspace, "added.txt")), false)
	})
})

test("selected ordinary restore verifies only required snapshot sources", () => {
	withTestTempDirectory("restore-selected-protected-", (root) => {
		const workspace = path.join(root, "workspace")
		const state = path.join(root, "state")
		fs.mkdirSync(workspace)
		fs.mkdirSync(state)
		fs.writeFileSync(path.join(workspace, "ordinary.txt"), "before")
		fs.writeFileSync(path.join(workspace, ".env"), "secret")
		const workspaceRoot = canonicalPath(workspace)
		const store = unwrap(
			createSnapshotStore({
				workspaceRoot,
				stateRoot: canonicalPath(state),
				policy: testPolicy(workspace, state, {
					noAccessPatterns: [pathPattern(path.join(workspace, ".env"), workspaceRoot)],
				}),
			}),
		)
		const published = unwrap(createSnapshot(store))
		const loaded = unwrap(loadSnapshot(store, published.id))
		fs.rmSync(path.join(published.directory, "protected", ".env"))
		fs.writeFileSync(path.join(workspace, "ordinary.txt"), "after")
		assert.equal(planRestore(store, loaded, { kind: "all" }).ok, false)
		const selected = unwrap(selectedRestoreScope(["ordinary.txt"]))
		unwrap(executeRestore(unwrap(planRestore(store, loaded, selected))))
		assert.equal(fs.readFileSync(path.join(workspace, "ordinary.txt"), "utf8"), "before")
	})
})

test("selected restore rejects excluded paths before mutation", () => {
	withTestTempDirectory("restore-excluded-", (root) => {
		const value = fixture(root)
		const scope = unwrap(selectedRestoreScope(["node_modules/preserved.js"]))
		const plan = planRestore(value.store, value.loaded, scope)
		assert.equal(plan.ok, false)
		if (!plan.ok) assert.equal(plan.error.kind, "excluded-selection")
	})
})

import { test } from "bun:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { unwrap } from "./result"
import { createSnapshot, createSnapshotStore, planSnapshot, stageSnapshot } from "./snapshot"
import { canonicalPath, protectedPattern } from "./test-domain-values"
import { withTestTempDirectory } from "./test-temp-directory"

function snapshotFixture(root: string, maxSnapshots = 20) {
	const workspace = path.join(root, "workspace")
	const state = path.join(root, "state")
	fs.mkdirSync(workspace)
	fs.mkdirSync(state)
	const workspaceRoot = canonicalPath(workspace)
	const protection = {
		patterns: [protectedPattern(path.join(workspace, "**", ".env*"), workspaceRoot)],
		protectedRoots: [],
	}
	const store = unwrap(
		createSnapshotStore({
			workspaceRoot,
			stateRoot: canonicalPath(state),
			protection,
			maxSnapshots,
		}),
	)
	return { workspace, workspaceRoot, state, protection, store }
}

test("plans supported entries without following symlinks and records exclusions", () => {
	withTestTempDirectory("snapshot-plan-", (root) => {
		const fixture = snapshotFixture(root)
		fs.mkdirSync(path.join(fixture.workspace, "src"))
		fs.writeFileSync(path.join(fixture.workspace, "src", "index.ts"), "export {}\n")
		fs.writeFileSync(path.join(fixture.workspace, ".env.local"), "TOKEN=secret\n")
		fs.symlinkSync("src/index.ts", path.join(fixture.workspace, "link"))
		fs.mkdirSync(path.join(fixture.workspace, ".git"))
		fs.writeFileSync(path.join(fixture.workspace, ".git", "index"), "excluded")
		fs.mkdirSync(path.join(fixture.workspace, ".pi"))
		fs.writeFileSync(path.join(fixture.workspace, ".pi", "tasks.db"), "generated")

		const plan = unwrap(
			planSnapshot({
				workspaceRoot: fixture.workspaceRoot,
				protection: fixture.protection,
			}),
		)
		assert.deepEqual(
			plan.entries.map((entry) => [entry.kind, entry.path, entry.kind === "file" ? entry.storage.kind : undefined]),
			[
				["file", ".env.local", "protected"],
				["excluded", ".git", undefined],
				["excluded", ".pi", undefined],
				["symlink", "link", undefined],
				["directory", "src", undefined],
				["file", "src/index.ts", "ordinary"],
			],
		)
	})
})

test("protected roots keep explicit public metadata exceptions ordinary", () => {
	withTestTempDirectory("snapshot-protected-root-", (root) => {
		const workspace = path.join(root, "workspace")
		const ssh = path.join(workspace, ".ssh")
		fs.mkdirSync(ssh, { recursive: true })
		fs.writeFileSync(path.join(ssh, "custom-private-key"), "private")
		fs.writeFileSync(path.join(ssh, "id_ed25519.pub"), "public")
		const workspaceRoot = canonicalPath(workspace)
		const plan = unwrap(
			planSnapshot({
				workspaceRoot,
				protection: {
					patterns: [],
					protectedRoots: [
						{
							root: canonicalPath(ssh),
							ordinaryExceptions: [protectedPattern(path.join(ssh, "**", "*.pub"), workspaceRoot)],
						},
					],
				},
			}),
		)
		assert.deepEqual(
			plan.entries.filter((entry) => entry.kind === "file").map((entry) => [entry.path, entry.storage.kind]),
			[
				[".ssh/custom-private-key", "protected"],
				[".ssh/id_ed25519.pub", "ordinary"],
			],
		)
	})
})

test("publishes clone-backed snapshots with a manifest and preserves excluded live paths", () => {
	withTestTempDirectory("snapshot-create-", (root) => {
		const fixture = snapshotFixture(root)
		fs.mkdirSync(path.join(fixture.workspace, "nested"))
		fs.writeFileSync(path.join(fixture.workspace, "nested", "file.txt"), "before\n", { mode: 0o640 })
		fs.writeFileSync(path.join(fixture.workspace, ".env"), "SECRET=before\n")
		fs.mkdirSync(path.join(fixture.workspace, "node_modules"))
		fs.writeFileSync(path.join(fixture.workspace, "node_modules", "generated.js"), "generated")

		const published = unwrap(createSnapshot(fixture.store))
		assert.equal(fs.readFileSync(path.join(published.directory, "tree", "nested", "file.txt"), "utf8"), "before\n")
		assert.equal(fs.readFileSync(path.join(published.directory, "protected", ".env"), "utf8"), "SECRET=before\n")
		assert.equal(fs.existsSync(path.join(published.directory, "tree", "node_modules")), false)

		const manifest = JSON.parse(fs.readFileSync(path.join(published.directory, "manifest.json"), "utf8"))
		assert.equal(manifest.version, 1)
		assert.equal(manifest.workspace, fixture.workspaceRoot)
		assert.ok(
			manifest.entries.some(
				(entry: { kind: string; path: string }) => entry.kind === "excluded" && entry.path === "node_modules",
			),
		)
		assert.equal(fs.statSync(published.directory).mode & 0o777, 0o700)
	})
})

test("rejects unsupported filesystem entries before creating staging output", () => {
	withTestTempDirectory("snapshot-unsupported-", (root) => {
		const fixture = snapshotFixture(root)
		const fifo = path.join(fixture.workspace, "events.fifo")
		const result = spawnSync("/usr/bin/mkfifo", [fifo], { encoding: "utf8" })
		assert.equal(result.status, 0, result.stderr)

		const planned = planSnapshot({
			workspaceRoot: fixture.workspaceRoot,
			protection: fixture.protection,
		})
		assert.equal(planned.ok, false)
		if (!planned.ok) assert.equal(planned.error.kind, "unsupported-entry")
		assert.equal(fs.existsSync(fixture.store.projectDirectory), false)
	})
})

test("rejects snapshot stores nested inside the workspace", () => {
	withTestTempDirectory("snapshot-store-boundary-", (root) => {
		const workspace = path.join(root, "workspace")
		fs.mkdirSync(workspace)
		const workspaceRoot = canonicalPath(workspace)
		const created = createSnapshotStore({
			workspaceRoot,
			stateRoot: canonicalPath(path.join(workspace, ".state")),
			protection: { patterns: [], protectedRoots: [] },
		})
		assert.equal(created.ok, false)
		if (!created.ok) assert.equal(created.error.kind, "invalid-store")
	})
})

test("failed staging is removed and never appears as published history", () => {
	withTestTempDirectory("snapshot-staging-failure-", (root) => {
		const fixture = snapshotFixture(root)
		const changing = path.join(fixture.workspace, "changing")
		fs.writeFileSync(changing, "file")
		const plan = unwrap(planSnapshot({ workspaceRoot: fixture.workspaceRoot, protection: fixture.protection }))
		fs.rmSync(changing)
		fs.mkdirSync(changing)
		fs.mkdirSync(fixture.store.projectDirectory, { recursive: true })

		const staged = stageSnapshot(plan, fixture.store.projectDirectory)
		assert.equal(staged.ok, false)
		assert.deepEqual(fs.readdirSync(fixture.store.projectDirectory), [])
	})
})

test("an existing project lock is not removed by a competing snapshot", () => {
	withTestTempDirectory("snapshot-lock-", (root) => {
		const fixture = snapshotFixture(root)
		fs.mkdirSync(fixture.store.projectDirectory, { recursive: true })
		const lock = path.join(fixture.store.projectDirectory, ".lock")
		fs.mkdirSync(lock)

		const created = createSnapshot(fixture.store)
		assert.equal(created.ok, false)
		if (!created.ok) assert.equal(created.error.kind, "project-locked")
		assert.equal(fs.existsSync(lock), true)
	})
})

test("retention can pin a restore source while publishing its redo checkpoint", () => {
	withTestTempDirectory("snapshot-retention-pin-", (root) => {
		const fixture = snapshotFixture(root, 2)
		const file = path.join(fixture.workspace, "value.txt")
		fs.writeFileSync(file, "one")
		const first = unwrap(createSnapshot(fixture.store))
		fs.writeFileSync(file, "two")
		const second = unwrap(createSnapshot(fixture.store))
		fs.writeFileSync(file, "three")
		unwrap(createSnapshot(fixture.store, { preserve: first.id }))
		assert.equal(fs.existsSync(first.directory), true)
		assert.equal(fs.existsSync(second.directory), false)
	})
})

test("retention fails atomically when all required snapshots cannot fit", () => {
	withTestTempDirectory("snapshot-retention-conflict-", (root) => {
		const fixture = snapshotFixture(root, 1)
		const file = path.join(fixture.workspace, "file.txt")
		fs.writeFileSync(file, "one")
		const first = unwrap(createSnapshot(fixture.store))
		fs.writeFileSync(file, "two")
		const conflicted = createSnapshot(fixture.store, { preserve: first.id })
		assert.equal(conflicted.ok, false)
		if (!conflicted.ok) assert.equal(conflicted.error.kind, "retention-conflict")
		assert.deepEqual(fs.readdirSync(fixture.store.projectDirectory), [first.id])
	})
})

test("retains only the configured number of successfully published snapshots", () => {
	withTestTempDirectory("snapshot-retention-", (root) => {
		const fixture = snapshotFixture(root, 2)
		const file = path.join(fixture.workspace, "value.txt")
		for (const value of ["one", "two", "three"]) {
			fs.writeFileSync(file, value)
			unwrap(createSnapshot(fixture.store))
		}
		const published = fs
			.readdirSync(fixture.store.projectDirectory, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		assert.equal(published.length, 2)
	})
})

import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { unwrap } from "./result"
import { type SnapshotPruneOptions, describeSnapshotPrune, pruneSnapshotStores } from "./snapshot-prune"
import { withTestTempDirectory } from "./test-temp-directory"

const DAY_MS = 24 * 60 * 60 * 1000

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0, 0)

function snapshotId(daysAgo: number, suffix: number): string {
	const compact = new Date(NOW - daysAgo * DAY_MS).toISOString().replace(/[^0-9]/g, "")

	return `${compact}-${suffix.toString(16).padStart(16, "0")}`
}

function project(root: string, name: string, entries: readonly string[]): string {
	const directory = path.join(root, name)
	fs.mkdirSync(directory, { recursive: true })

	for (const entry of entries) {
		fs.mkdirSync(path.join(directory, entry))
		fs.writeFileSync(path.join(directory, entry, "manifest.json"), "{}")
	}

	return directory
}

function options(root: string, overrides: Partial<SnapshotPruneOptions> = {}): SnapshotPruneOptions {
	return { snapshotsRoot: root, maxSnapshots: 3, maxAgeMs: 7 * DAY_MS, now: NOW, execution: "apply", ...overrides }
}

test("prune removes expired snapshots, then keeps the newest within the per-project limit", () => {
	withTestTempDirectory("snapshot-prune-", (root) => {
		const ids = [10, 8, 5, 4, 3, 2, 1].map((daysAgo, index) => snapshotId(daysAgo, index))
		const directory = project(root, "a".repeat(24), ids)

		const actions = unwrap(pruneSnapshotStores(options(root)))

		assert.deepEqual(
			actions.map((action) => [action.reason, path.basename(action.path)]),
			[
				["expired", ids[0]],
				["expired", ids[1]],
				["over-limit", ids[2]],
				["over-limit", ids[3]],
			],
		)
		assert.deepEqual(fs.readdirSync(directory).sort(), ids.slice(4))
	})
})

test("prune dry-run reports without removing anything", () => {
	withTestTempDirectory("snapshot-prune-dry-run-", (root) => {
		const ids = [snapshotId(30, 1), snapshotId(1, 2)]
		const directory = project(root, "b".repeat(24), ids)
		fs.mkdirSync(path.join(directory, ".staging-x"))
		project(root, "c".repeat(24), [])

		const actions = unwrap(pruneSnapshotStores(options(root, { execution: "dry-run" })))

		assert.deepEqual(
			actions.map((action) => [action.reason, path.relative(root, action.path)]),
			[
				["expired", path.join("b".repeat(24), ids[0])],
				["stale-staging", path.join("b".repeat(24), ".staging-x")],
				["empty-project", "c".repeat(24)],
			],
		)
		assert.match(describeSnapshotPrune(actions, "dry-run"), /would remove 1 snapshots; pass --apply/)
		assert.deepEqual(fs.readdirSync(directory).sort(), [".staging-x", ...ids].sort())
		assert.equal(fs.existsSync(path.join(root, "c".repeat(24))), true)
	})
})

test("prune removes interrupted staging and folders left empty", () => {
	withTestTempDirectory("snapshot-prune-empty-", (root) => {
		const directory = project(root, "d".repeat(24), [snapshotId(20, 1)])
		fs.mkdirSync(path.join(directory, ".staging-abc"))
		fs.writeFileSync(path.join(directory, ".clone-probe-abc"), "probe")

		const actions = unwrap(pruneSnapshotStores(options(root)))

		assert.deepEqual(
			actions.map((action) => action.reason),
			["expired", "stale-staging", "stale-staging", "empty-project"],
		)
		assert.equal(fs.existsSync(directory), false)
	})
})

test("prune skips locked projects and ignores unrelated folders", () => {
	withTestTempDirectory("snapshot-prune-locked-", (root) => {
		const old = snapshotId(30, 1)
		const locked = project(root, "e".repeat(24), [old])
		fs.mkdirSync(path.join(locked, ".lock"))
		const unrelated = project(root, "not-a-project", [old])

		const actions = unwrap(pruneSnapshotStores(options(root)))

		assert.deepEqual(actions, [{ kind: "skip", path: path.join(locked, ".lock"), reason: "locked" }])
		assert.equal(fs.existsSync(path.join(locked, old)), true)
		assert.equal(fs.existsSync(path.join(locked, ".lock")), true)
		assert.equal(fs.existsSync(path.join(unrelated, old)), true)
	})
})

test("prune releases the project lock and tolerates a missing store", () => {
	withTestTempDirectory("snapshot-prune-lock-release-", (root) => {
		const directory = project(root, "f".repeat(24), [snapshotId(1, 1)])

		assert.deepEqual(unwrap(pruneSnapshotStores(options(root))), [])
		assert.equal(fs.existsSync(path.join(directory, ".lock")), false)
		assert.deepEqual(unwrap(pruneSnapshotStores(options(path.join(root, "missing")))), [])
	})
})

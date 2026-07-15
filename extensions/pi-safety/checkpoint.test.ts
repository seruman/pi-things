import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { CheckpointRun } from "./checkpoint"
import { err, ok, unwrap } from "./result"
import { type PublishedSnapshotRef, createSnapshot, createSnapshotStore } from "./snapshot"
import { canonicalPath, testPolicy } from "./test-domain-values"
import { withTestTempDirectoryAsync } from "./test-temp-directory"

function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
	let release: () => void = () => {
		throw new Error("deferred promise released before initialization")
	}
	const promise = new Promise<void>((resolve) => {
		release = resolve
	})
	return { promise, release }
}

async function publishedSnapshot(root: string): Promise<PublishedSnapshotRef> {
	const workspace = path.join(root, "workspace")
	const state = path.join(root, "state")
	fs.mkdirSync(workspace)
	fs.mkdirSync(state)
	fs.writeFileSync(path.join(workspace, "file.txt"), "before")
	const store = unwrap(
		createSnapshotStore({
			workspaceRoot: canonicalPath(workspace),
			stateRoot: canonicalPath(state),
			policy: testPolicy(workspace, state),
		}),
	)
	return unwrap(createSnapshot(store))
}

test("concurrent first mutations share one checkpoint and later calls reuse it", async () => {
	await withTestTempDirectoryAsync("checkpoint-concurrent-", async (root) => {
		const published = await publishedSnapshot(root)
		const gate = deferred()
		let creations = 0
		const run = new CheckpointRun(async () => {
			creations += 1
			await gate.promise
			return ok(published)
		})

		assert.deepEqual(run.status(), { kind: "not-started" })
		const first = run.ensureCheckpoint()
		const second = run.ensureCheckpoint()
		assert.deepEqual(run.status(), { kind: "creating" })
		await Promise.resolve()
		assert.equal(creations, 1)
		gate.release()

		const [firstResult, secondResult] = await Promise.all([first, second])
		assert.deepEqual(firstResult, ok(published))
		assert.deepEqual(secondResult, ok(published))
		assert.deepEqual(run.status(), { kind: "ready", snapshot: published })
		assert.deepEqual(await run.ensureCheckpoint(), ok(published))
		assert.equal(creations, 1)
	})
})

test("checkpoint failure is terminal for the run", async () => {
	await withTestTempDirectoryAsync("checkpoint-failure-", async (root) => {
		const failure = { kind: "project-locked", path: path.join(root, ".lock") } as const
		let creations = 0
		const run = new CheckpointRun(async () => {
			creations += 1
			return err(failure)
		})

		const first = await run.ensureCheckpoint()
		assert.deepEqual(first, err({ kind: "snapshot-failed", cause: failure }))
		assert.deepEqual(run.status(), { kind: "failed", error: { kind: "snapshot-failed", cause: failure } })
		assert.deepEqual(await run.ensureCheckpoint(), first)
		assert.equal(creations, 1)
	})
})

test("unexpected creator rejection becomes a typed terminal failure", async () => {
	const run = new CheckpointRun(async () => {
		throw new Error("creator exploded")
	})
	const result = await run.ensureCheckpoint()
	assert.deepEqual(result, { ok: false, error: { kind: "creator-rejected", message: "creator exploded" } })
	assert.deepEqual(run.status(), {
		kind: "failed",
		error: { kind: "creator-rejected", message: "creator exploded" },
	})
})

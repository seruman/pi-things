import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { unwrap } from "./result"
import { createSafetySession } from "./safety-session"
import { withTestTempDirectoryAsync } from "./test-temp-directory"

function fixture(root: string) {
	const workspace = path.join(root, "workspace")
	const home = path.join(root, "home")
	const stateHome = path.join(root, "state")
	const piConfigDir = path.join(root, "pi-config")
	const privateTemp = path.join(root, "tmp")
	for (const directory of [workspace, home, stateHome, piConfigDir, privateTemp]) fs.mkdirSync(directory)
	fs.writeFileSync(path.join(workspace, "existing.txt"), "before")
	return unwrap(
		createSafetySession({
			cwd: workspace,
			home,
			stateHome,
			piConfigDir,
			additionalNoAccessPatterns: [],
			privateTemp,
			integrationEnvironment: {
				path: undefined,
				sshAuthSock: undefined,
				dockerHost: undefined,
				dockerContext: undefined,
			},
		}),
	)
}

test("reads and denied mutations do not create a lazy checkpoint", async () => {
	await withTestTempDirectoryAsync("safety-session-read-", async (root) => {
		const session = fixture(root)
		session.beginAgentRun()

		const read = await session.authorize("read", { path: "existing.txt" })
		assert.equal(read.kind, "allow")
		const denied = await session.authorize("write", { path: path.join(root, "outside.txt"), content: "x" })
		assert.equal(denied.kind, "block")
		const privateTempDenied = await session.authorize("write", {
			path: path.join(root, "tmp", "built-in.txt"),
			content: "x",
		})
		assert.equal(privateTempDenied.kind, "block")
		assert.deepEqual(session.checkpointStatus(), { kind: "not-started" })
		assert.equal(fs.existsSync(session.snapshotStore.projectDirectory), false)
	})
})

test("the first allowed mutation snapshots once and later mutations reuse it", async () => {
	await withTestTempDirectoryAsync("safety-session-mutate-", async (root) => {
		const session = fixture(root)
		session.beginAgentRun()

		assert.equal((await session.authorize("write", { path: "new.txt", content: "x" })).kind, "allow")
		assert.equal(
			(await session.authorize("edit", { path: "existing.txt", oldText: "before", newText: "after" })).kind,
			"allow",
		)
		const status = session.checkpointStatus()
		assert.equal(status.kind, "ready")
		assert.equal(
			fs
				.readdirSync(session.snapshotStore.projectDirectory, { withFileTypes: true })
				.filter((entry) => !entry.name.startsWith(".")).length,
			1,
		)
	})
})

test("concurrent allowed mutations await the same real snapshot", async () => {
	await withTestTempDirectoryAsync("safety-session-concurrent-", async (root) => {
		const session = fixture(root)
		unwrap(session.beginAgentRun())
		const decisions = await Promise.all([
			session.authorize("write", { path: "first.txt", content: "x" }),
			session.authorize("write", { path: "second.txt", content: "y" }),
		])
		assert.ok(decisions.every((decision) => decision.kind === "allow"))
		assert.equal(
			fs
				.readdirSync(session.snapshotStore.projectDirectory, { withFileTypes: true })
				.filter((entry) => !entry.name.startsWith(".")).length,
			1,
		)
	})
})

test("each agent run receives a fresh lazy checkpoint", async () => {
	await withTestTempDirectoryAsync("safety-session-runs-", async (root) => {
		const session = fixture(root)
		session.beginAgentRun()
		assert.equal((await session.authorize("bash", { command: "true" })).kind, "allow")
		session.beginAgentRun()
		assert.deepEqual(session.checkpointStatus(), { kind: "not-started" })
		assert.equal((await session.authorize("bash", { command: "true" })).kind, "allow")
		assert.equal(
			fs
				.readdirSync(session.snapshotStore.projectDirectory, { withFileTypes: true })
				.filter((entry) => !entry.name.startsWith(".")).length,
			2,
		)
	})
})

test("a new run cannot replace a checkpoint while creation is in flight", async () => {
	await withTestTempDirectoryAsync("safety-session-in-flight-", async (root) => {
		const session = fixture(root)
		unwrap(session.beginAgentRun())
		const mutation = session.authorize("bash", { command: "true" })
		assert.deepEqual(session.beginAgentRun(), { ok: false, error: { kind: "checkpoint-creation-in-progress" } })
		assert.equal((await mutation).kind, "allow")
	})
})

test("tool calls fail closed before an agent run starts", async () => {
	await withTestTempDirectoryAsync("safety-session-uninitialized-", async (root) => {
		const session = fixture(root)
		const decision = await session.authorize("write", { path: "new.txt", content: "x" })
		assert.deepEqual(decision, {
			kind: "block",
			reason: "pi-safety: checkpoint run has not started",
		})
	})
})

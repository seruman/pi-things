import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { unwrap } from "./result"
import { createSafetySession } from "./safety-session"
import { parseSnapshotSessionId } from "./snapshot"
import { withTestTempDirectoryAsync } from "./test-temp-directory"

function fixture(root: string, gopath?: string) {
	const workspace = path.join(root, "workspace")
	const home = path.join(root, "home")
	const stateHome = path.join(root, "state")
	const piConfigDir = path.join(root, "pi-config")
	const privateTemp = path.join(root, "tmp")
	for (const directory of [workspace, home, stateHome, piConfigDir, privateTemp])
		fs.mkdirSync(directory, { recursive: true })
	fs.writeFileSync(path.join(workspace, "existing.txt"), "before")
	return unwrap(
		createSafetySession({
			cwd: workspace,
			home,
			stateHome,
			piConfigDir,
			additionalNoAccessPatterns: [],
			gopath,
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

test("exposes the session's resolved policy without changing checkpoint state", async () => {
	await withTestTempDirectoryAsync("safety-session-policy-", async (root) => {
		const session = fixture(root)
		const description = session.policyDescription()
		assert.match(description, /Pi Safety policy \(ordered;/)
		assert.ok(description.includes(`workspace ${JSON.stringify(path.join(root, "workspace"))}`))
		assert.match(description, /file shared none tree=.*\.cf/)
		assert.match(description, /runtime operations allow/)
		assert.deepEqual(session.checkpointStatus(), { kind: "run-not-started" })
	})
})

test("uses default and configured GOPATH package caches", async () => {
	await withTestTempDirectoryAsync("safety-session-gopath-", async (root) => {
		const defaultRoot = path.join(root, "default")
		const defaultSession = fixture(defaultRoot)
		assert.ok(defaultSession.policyDescription().includes(path.join(defaultRoot, "home", "go", "pkg")))

		const configuredRoot = path.join(root, "configured")
		const custom = path.join(configuredRoot, "custom-go")
		fs.mkdirSync(custom, { recursive: true })
		const configuredSession = fixture(configuredRoot, custom)
		assert.ok(configuredSession.policyDescription().includes(path.join(custom, "pkg")))
	})
})

test("session paths grant and revoke uncheckpointed external write authority", async () => {
	await withTestTempDirectoryAsync("safety-session-paths-", async (root) => {
		const session = fixture(root)
		const external = path.join(root, "other-repo")
		fs.mkdirSync(external)

		assert.equal(session.guard("write", { path: path.join(external, "file.txt"), content: "x" }).kind, "block")
		assert.equal(session.addSessionPath(external, "read-write").ok, true)
		assert.deepEqual(session.sessionPaths(), [{ path: external, access: "read-write" }])

		assert.equal(session.guard("write", { path: path.join(external, "file.txt"), content: "x" }).kind, "allow")
		assert.deepEqual(session.removeSessionPath(external), { ok: true, value: true })
		assert.equal(session.guard("write", { path: path.join(external, "file.txt"), content: "x" }).kind, "block")
	})
})

test("reads and denied mutations do not create a lazy checkpoint", async () => {
	await withTestTempDirectoryAsync("safety-session-read-", async (root) => {
		const session = fixture(root)
		session.beginAgentRun()

		assert.equal(session.guard("read", { path: "existing.txt" }).kind, "allow")
		assert.equal(session.guard("write", { path: path.join(root, "outside.txt"), content: "x" }).kind, "block")
		assert.deepEqual(session.checkpointStatus(), { kind: "not-started" })
		assert.equal(fs.existsSync(session.snapshotStore.projectDirectory), false)
	})
})

test("the first allowed mutation snapshots once and later mutations reuse it", async () => {
	await withTestTempDirectoryAsync("safety-session-mutate-", async (root) => {
		const session = fixture(root)
		session.beginAgentRun()

		assert.equal(session.guard("write", { path: "new.txt", content: "x" }).kind, "allow")
		assert.equal((await session.checkpoint("write")).kind, "allow")
		assert.equal((await session.checkpoint("edit")).kind, "allow")
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

test("records the Pi session that owns an automatic checkpoint", async () => {
	await withTestTempDirectoryAsync("safety-session-origin-", async (root) => {
		const session = fixture(root)
		const sessionId = unwrap(parseSnapshotSessionId("019f6277-361d-7f97-9d5b-7db7e0618fe1"))
		unwrap(session.beginAgentRun({ kind: "pi-session", sessionId }))
		assert.equal((await session.checkpoint("write")).kind, "allow")
		const status = session.checkpointStatus()
		assert.equal(status.kind, "ready")
		if (status.kind !== "ready") return
		const manifest = JSON.parse(fs.readFileSync(path.join(status.snapshot.directory, "manifest.json"), "utf8"))
		assert.deepEqual(manifest.origin, { kind: "pi-session", sessionId })
	})
})

test("concurrent allowed mutations await the same real snapshot", async () => {
	await withTestTempDirectoryAsync("safety-session-concurrent-", async (root) => {
		const session = fixture(root)
		unwrap(session.beginAgentRun())
		const decisions = await Promise.all([session.checkpoint("write"), session.checkpoint("write")])
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
		assert.equal((await session.checkpoint("bash")).kind, "allow")
		session.beginAgentRun()
		assert.deepEqual(session.checkpointStatus(), { kind: "not-started" })
		assert.equal((await session.checkpoint("bash")).kind, "allow")
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
		const mutation = session.checkpoint("bash")
		assert.deepEqual(session.beginAgentRun(), { ok: false, error: { kind: "checkpoint-creation-in-progress" } })
		assert.equal((await mutation).kind, "allow")
	})
})

test("tool calls fail closed before an agent run starts", async () => {
	await withTestTempDirectoryAsync("safety-session-uninitialized-", async (root) => {
		const session = fixture(root)
		const decision = await session.checkpoint("write")
		assert.deepEqual(decision, {
			kind: "block",
			reason: "pi-safety: checkpoint run has not started",
		})
	})
})

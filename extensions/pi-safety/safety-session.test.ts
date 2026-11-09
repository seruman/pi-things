import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { unwrap } from "./result"
import { createSafetySession } from "./safety-session"
import { withTestTempDirectoryAsync } from "./test-temp-directory"

function fixture(root: string, gopath?: string) {
	const workspace = path.join(root, "workspace")
	const home = path.join(root, "home")
	const stateHome = path.join(root, "state")
	const piConfigDir = path.join(root, "pi-config")
	const privateTemp = path.join(root, "tmp")

	for (const directory of [workspace, home, stateHome, piConfigDir, privateTemp]) {
		fs.mkdirSync(directory, { recursive: true })
	}

	fs.writeFileSync(path.join(workspace, "existing.txt"), "before")

	return unwrap(
		createSafetySession({
			cwd: workspace,
			home,
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

test("exposes the session's resolved policy", async () => {
	await withTestTempDirectoryAsync("safety-session-policy-", async (root) => {
		const session = fixture(root)
		const description = session.policyDescription()
		assert.match(description, /Pi Safety policy \(ordered;/)
		assert.ok(description.includes(`workspace ${JSON.stringify(path.join(root, "workspace"))}`))
		assert.match(description, /file shared none tree=.*\.cf/)
		assert.match(description, /runtime operations allow/)
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

test("session paths grant and revoke external write authority", async () => {
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

test("allows workspace reads and denies outside mutations", async () => {
	await withTestTempDirectoryAsync("safety-session-read-", async (root) => {
		const session = fixture(root)
		assert.equal(session.guard("read", { path: "existing.txt" }).kind, "allow")
		assert.equal(session.guard("write", { path: path.join(root, "outside.txt"), content: "x" }).kind, "block")
	})
})

test("allows workspace mutations", async () => {
	await withTestTempDirectoryAsync("safety-session-mutate-", async (root) => {
		const session = fixture(root)
		assert.equal(session.guard("write", { path: "new.txt", content: "x" }).kind, "allow")
	})
})

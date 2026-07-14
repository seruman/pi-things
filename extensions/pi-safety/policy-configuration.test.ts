import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { parseInitialFilePolicy } from "./policy-configuration"
import { unwrap } from "./result"
import { withTestTempDirectory } from "./test-temp-directory"
import { authorizeBuiltinToolCall } from "./tool-authorization"

test("initial policy protects ambient credentials, project secrets, snapshots, and Pi state", () => {
	withTestTempDirectory("file-policy-configuration-", (root) => {
		const workspace = path.join(root, "workspace")
		const home = path.join(root, "home")
		const stateHome = path.join(root, "state")
		const piConfigDir = path.join(root, "pi-agent")
		const ssh = path.join(home, ".ssh")
		const aws = path.join(home, ".aws")
		const protectedSnapshot = path.join(stateHome, "pi-safety", "snapshots", "project-1", "snapshot-1", "protected")
		for (const directory of [workspace, home, stateHome, piConfigDir, ssh, aws, protectedSnapshot]) {
			fs.mkdirSync(directory, { recursive: true })
		}

		const privateKey = path.join(ssh, "custom-github-key")
		const publicKey = path.join(ssh, "id_ed25519.pub")
		const credentials = path.join(aws, "credentials")
		const envFile = path.join(workspace, "nested", ".env.local")
		const configuredSecret = path.join(workspace, "secrets", "custom.txt")
		const piAuth = path.join(piConfigDir, "auth.json")
		const snapshotSecret = path.join(protectedSnapshot, "nested", "token.txt")
		for (const file of [privateKey, publicKey, credentials, envFile, configuredSecret, piAuth, snapshotSecret]) {
			fs.mkdirSync(path.dirname(file), { recursive: true })
			fs.writeFileSync(file, "x")
		}

		const policy = unwrap(
			parseInitialFilePolicy({
				cwd: workspace,
				home,
				stateHome,
				piConfigDir,
				additionalNoAccessPatterns: ["secrets/custom.txt"],
			}),
		)

		for (const secret of [privateKey, credentials, envFile, configuredSecret, piAuth]) {
			const result = authorizeBuiltinToolCall("read", { path: secret }, policy)
			assert.equal(result.ok, false, `expected ${secret} to be protected`)
			if (!result.ok) assert.equal(result.error.kind, "access-denied")
		}

		const publicRead = authorizeBuiltinToolCall("read", { path: publicKey }, policy)
		assert.equal(publicRead.ok, true)

		const protectedRead = authorizeBuiltinToolCall("read", { path: snapshotSecret }, policy)
		assert.equal(protectedRead.ok, false)
		if (!protectedRead.ok) assert.equal(protectedRead.error.kind, "access-denied")

		for (const protectedWrite of [
			path.join(workspace, ".git", "hooks", "post-commit"),
			path.join(workspace, ".mcp.json"),
			path.join(workspace, ".cursor", "rules", "safety.mdc"),
			path.join(home, ".zshrc"),
		]) {
			const result = authorizeBuiltinToolCall("write", { path: protectedWrite, content: "x" }, policy)
			assert.equal(result.ok, false, `expected ${protectedWrite} to be write-protected`)
			if (!result.ok) assert.equal(result.error.kind, "access-denied")
		}

		for (const immutable of [
			path.join(stateHome, "pi-safety", "snapshots", "new"),
			path.join(piConfigDir, "settings.json"),
			path.join(workspace, ".pi", "pi-safety.json"),
		]) {
			const result = authorizeBuiltinToolCall("write", { path: immutable, content: "x" }, policy)
			assert.equal(result.ok, false, `expected ${immutable} to be immutable`)
			if (!result.ok) assert.equal(result.error.kind, "access-denied")
		}
	})
})

test("default rule path failures are returned instead of thrown", () => {
	withTestTempDirectory("file-policy-path-error-", (root) => {
		const workspace = path.join(root, "workspace")
		const home = path.join(root, "home")
		const stateHome = path.join(root, "state")
		const piConfigDir = path.join(root, "pi-agent")
		for (const directory of [workspace, home, stateHome, piConfigDir]) fs.mkdirSync(directory)
		fs.symlinkSync(path.join(root, "missing-ssh"), path.join(home, ".ssh"))

		const parsed = parseInitialFilePolicy({
			cwd: workspace,
			home,
			stateHome,
			piConfigDir,
			additionalNoAccessPatterns: [],
		})
		assert.equal(parsed.ok, false)
		if (!parsed.ok) {
			assert.equal(parsed.error.kind, "default-rules")
			if (parsed.error.kind === "default-rules") assert.equal(parsed.error.cause.kind, "rule-path")
		}
	})
})

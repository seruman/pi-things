import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { createDefaultPolicy } from "./default-policy"
import { parseInitialSafetyConfiguration } from "./policy-configuration"
import { unwrap } from "./result"
import { withTestTempDirectory } from "./test-temp-directory"
import { authorizeBuiltinToolCall } from "./tool-authorization"

test("initial policy protects ambient credentials, project secrets, and Pi state", () => {
	withTestTempDirectory("policy-configuration-", (root) => {
		const workspace = path.join(root, "workspace")
		const home = path.join(root, "home")
		const stateHome = path.join(root, "state")
		const piConfigDir = path.join(root, "pi-agent")
		const ssh = path.join(home, ".ssh")
		const aws = path.join(home, ".aws")

		for (const directory of [workspace, home, stateHome, piConfigDir, ssh, aws]) {
			fs.mkdirSync(directory, { recursive: true })
		}

		const privateKey = path.join(ssh, "custom-github-key")
		const publicKey = path.join(ssh, "id_ed25519.pub")
		const credentials = path.join(aws, "credentials")
		const envFile = path.join(workspace, "nested", ".env.local")
		const configuredSecret = path.join(workspace, "secrets", "custom.txt")
		const piAuth = path.join(piConfigDir, "auth.json")

		for (const file of [privateKey, publicKey, credentials, envFile, configuredSecret, piAuth]) {
			fs.mkdirSync(path.dirname(file), { recursive: true })
			fs.writeFileSync(file, "x")
		}

		const configuration = unwrap(
			parseInitialSafetyConfiguration({
				cwd: workspace,
				home,
				piConfigDir,
				additionalNoAccessPatterns: ["secrets/custom.txt"],
			}),
		)

		const policy = unwrap(
			createDefaultPolicy({
				paths: configuration.paths,
				additionalNoAccessPatterns: configuration.additionalNoAccessPatterns,
				sandbox: { kind: "disabled" },
			}),
		)

		for (const secret of [privateKey, credentials, envFile, configuredSecret, piAuth]) {
			const result = authorizeBuiltinToolCall("read", { path: secret }, policy)
			assert.equal(result.ok, false, `expected ${secret} to be protected`)

			if (!result.ok) assert.equal(result.error.kind, "access-denied")
		}

		const publicRead = authorizeBuiltinToolCall("read", { path: publicKey }, policy)
		assert.equal(publicRead.ok, true)

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

		for (const immutable of [path.join(piConfigDir, "settings.json"), path.join(workspace, ".pi", "pi-safety.json")]) {
			const result = authorizeBuiltinToolCall("write", { path: immutable, content: "x" }, policy)
			assert.equal(result.ok, false, `expected ${immutable} to be immutable`)

			if (!result.ok) assert.equal(result.error.kind, "access-denied")
		}
	})
})

test("default policy path failures are returned instead of thrown", () => {
	withTestTempDirectory("policy-path-error-", (root) => {
		const workspace = path.join(root, "workspace")
		const home = path.join(root, "home")
		const stateHome = path.join(root, "state")
		const piConfigDir = path.join(root, "pi-agent")

		for (const directory of [workspace, home, stateHome, piConfigDir]) fs.mkdirSync(directory)
		fs.symlinkSync(path.join(root, "missing-ssh"), path.join(home, ".ssh"))

		const configuration = unwrap(
			parseInitialSafetyConfiguration({
				cwd: workspace,
				home,
				piConfigDir,
				additionalNoAccessPatterns: [],
			}),
		)

		const policy = createDefaultPolicy({
			paths: configuration.paths,
			additionalNoAccessPatterns: configuration.additionalNoAccessPatterns,
			sandbox: { kind: "disabled" },
		})

		assert.equal(policy.ok, false)

		if (!policy.ok) assert.equal(policy.error.kind, "rule-path")
	})
})

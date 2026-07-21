import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { createDefaultPolicy, createSnapshotPolicy } from "./default-policy"
import { type EvaluationSubject, evaluatePolicy } from "./policy"
import { unwrap } from "./result"
import { emitSeatbelt } from "./seatbelt"
import { canonicalExecutable, canonicalPath } from "./test-domain-values"
import { assertDenied, runWithSeatbeltProfile } from "./test-seatbelt"
import { withTestTempDirectory } from "./test-temp-directory"

test("a final shared denial constrains sandbox runtime capabilities", () => {
	withTestTempDirectory("default-policy-capability-ceiling-", (root) => {
		const workspace = path.join(root, "workspace")
		const home = path.join(root, "home")
		const stateHome = path.join(root, "state")
		const piConfigDirectory = path.join(root, "pi-agent")
		const privateTemp = path.join(root, "tmp")
		for (const directory of [workspace, home, stateHome, piConfigDirectory, privateTemp]) fs.mkdirSync(directory)
		const policy = unwrap(
			createDefaultPolicy({
				paths: {
					workspace: canonicalPath(workspace),
					home: canonicalPath(home),
					stateHome: canonicalPath(stateHome),
					piConfigDirectory: canonicalPath(piConfigDirectory),
				},
				additionalNoAccessPatterns: ["/dev/null"],
				sandbox: {
					kind: "enabled",
					privateTemp: canonicalPath(privateTemp),
					integrations: {
						gitExecutable: canonicalExecutable("/usr/bin/git"),
						nix: { kind: "disabled" },
						sshAgent: { kind: "disabled" },
						docker: { kind: "disabled" },
						wb: { kind: "disabled" },
					},
				},
			}),
		)
		const nullDevice = canonicalPath("/dev/null")
		assert.equal(
			evaluatePolicy(policy, {
				kind: "file-access",
				operation: "write",
				subject: { kind: "sandbox" },
				path: nullDevice,
			}).effect,
			"deny",
		)
		assertDenied(
			runWithSeatbeltProfile(emitSeatbelt(policy), "/bin/bash", ["-c", "printf blocked > /dev/null"], workspace),
		)
	})
})

test("Nix daemon access is scoped to the canonical Nix executable", () => {
	withTestTempDirectory("default-policy-nix-process-", (root) => {
		const workspace = path.join(root, "workspace")
		const home = path.join(root, "home")
		const stateHome = path.join(root, "state")
		const piConfigDirectory = path.join(root, "pi-agent")
		const privateTemp = path.join(root, "tmp")
		const cacheDirectory = path.join(home, ".cache", "nix")
		for (const directory of [workspace, home, stateHome, piConfigDirectory, privateTemp, cacheDirectory]) {
			fs.mkdirSync(directory, { recursive: true })
		}
		const nixExecutable = canonicalExecutable(process.execPath)
		const daemonSocket = canonicalPath(path.join(root, "nix-daemon.sock"))
		const policy = unwrap(
			createDefaultPolicy({
				paths: {
					workspace: canonicalPath(workspace),
					home: canonicalPath(home),
					stateHome: canonicalPath(stateHome),
					piConfigDirectory: canonicalPath(piConfigDirectory),
				},
				additionalNoAccessPatterns: [],
				sandbox: {
					kind: "enabled",
					privateTemp: canonicalPath(privateTemp),
					integrations: {
						gitExecutable: canonicalExecutable("/usr/bin/git"),
						nix: {
							kind: "enabled",
							executable: nixExecutable,
							cacheDirectory: canonicalPath(cacheDirectory),
							daemon: { kind: "unix-socket", socket: daemonSocket },
						},
						sshAgent: { kind: "disabled" },
						docker: { kind: "disabled" },
						wb: { kind: "disabled" },
					},
				},
			}),
		)
		const daemonRule = policy.rules.find(
			(rule) =>
				rule.kind === "unix-connect" &&
				rule.effect === "allow" &&
				rule.matchers.some((matcher) => matcher.kind === "path" && matcher.path === daemonSocket),
		)
		assert.equal(daemonRule?.kind, "unix-connect")
		if (daemonRule?.kind === "unix-connect") assert.equal(daemonRule.process, nixExecutable)
	})
})

test("every default access and snapshot declaration has an observable policy decision", () => {
	withTestTempDirectory("default-policy-decisions-", (root) => {
		const workspace = path.join(root, "workspace")
		const home = path.join(root, "home")
		const stateHome = path.join(root, "state")
		const piConfigDirectory = path.join(root, "pi-agent")
		const privateTemp = path.join(root, "tmp")
		for (const directory of [workspace, home, stateHome, piConfigDirectory, privateTemp]) fs.mkdirSync(directory)
		const git = canonicalExecutable("/usr/bin/git")
		const policy = unwrap(
			createDefaultPolicy({
				paths: {
					workspace: canonicalPath(workspace),
					home: canonicalPath(home),
					stateHome: canonicalPath(stateHome),
					piConfigDirectory: canonicalPath(piConfigDirectory),
				},
				additionalNoAccessPatterns: ["custom-secrets/**"],
				sandbox: {
					kind: "enabled",
					privateTemp: canonicalPath(privateTemp),
					integrations: {
						gitExecutable: git,
						nix: { kind: "disabled" },
						sshAgent: { kind: "disabled" },
						docker: { kind: "disabled" },
						wb: { kind: "disabled" },
					},
				},
			}),
		)
		const access = (pathname: string, operation: "read" | "write", subject: EvaluationSubject = { kind: "builtin" }) =>
			evaluatePolicy(policy, {
				kind: "file-access",
				operation,
				subject,
				path: canonicalPath(pathname),
			}).effect

		assert.equal(access(path.join(root, "host-file"), "read"), "allow")
		assert.equal(access(path.join(root, "host-file"), "write"), "deny")
		assert.equal(access(path.join(workspace, "src", "index.ts"), "write"), "allow")
		assert.equal(access(path.join(privateTemp, "sandbox-file"), "write"), "deny")
		assert.equal(access(path.join(privateTemp, "sandbox-file"), "write", { kind: "sandbox" }), "allow")
		assert.equal(access("/private/tmp/pi-safety-file", "write"), "deny")
		assert.equal(access("/private/tmp/pi-safety-file", "write", { kind: "sandbox" }), "allow")

		const projectConfiguration = [
			[".git", "hooks", "post-commit"],
			[".git", "config"],
			[".git", "config.worktree"],
			[".pi", "pi-safety.json"],
			[".mcp.json"],
			[".claude", "settings.json"],
			[".cursor", "rules", "safety.mdc"],
			[".cursor", "mcp.json"],
			[".github", "instructions", "review.md"],
			[".github", "copilot-instructions.md"],
			[".vscode", "settings.json"],
			[".vscode", "tasks.json"],
			[".vscode", "mcp.json"],
		] as const
		for (const components of projectConfiguration) {
			const pathname = path.join(workspace, ...components)
			assert.equal(access(pathname, "read"), "allow", pathname)
			assert.equal(access(pathname, "write"), "deny", pathname)
		}
		for (const components of [
			[".git", "hooks", "post-commit"],
			[".git", "config"],
			[".git", "config.worktree"],
		] as const) {
			assert.equal(
				access(path.join(workspace, ...components), "write", { kind: "executable", executable: git }),
				"allow",
			)
		}

		for (const components of [
			[".bashrc"],
			[".bash_profile"],
			[".profile"],
			[".zshrc"],
			[".zprofile"],
			[".gitconfig"],
			[".config", "git", "config"],
			[".config", "fish", "config.fish"],
		] as const) {
			const pathname = path.join(home, ...components)
			assert.equal(access(pathname, "read"), "allow", pathname)
			assert.equal(access(pathname, "write"), "deny", pathname)
		}

		const sshDirectory = path.join(home, ".ssh")
		for (const components of [
			["id_ed25519.pub"],
			["team", "deploy.pub"],
			["config"],
			["config.d"],
			["config.d", "work"],
			["known_hosts"],
			["known_hosts.old"],
			["allowed_signers"],
			["authorized_keys"],
		] as const) {
			const pathname = path.join(sshDirectory, ...components)
			assert.equal(access(pathname, "read"), "allow", pathname)
			assert.equal(access(pathname, "write"), "deny", pathname)
		}
		for (const pathname of [
			path.join(sshDirectory, "id_ed25519"),
			path.join(home, ".aws", "credentials"),
			path.join(home, ".cf", "credentials"),
			path.join(piConfigDirectory, "auth.json"),
			path.join(workspace, ".env"),
			path.join(workspace, "nested", ".env.local"),
			path.join(workspace, "service.env"),
			path.join(workspace, "nested", "service.env.production"),
			path.join(workspace, "custom-secrets", "token"),
			path.join(stateHome, "pi-safety", "snapshots", "project", "snapshot", "protected", "token"),
		]) {
			assert.equal(access(pathname, "read"), "deny", pathname)
			assert.equal(access(pathname, "write"), "deny", pathname)
		}

		const snapshotOnlyPolicy = unwrap(createSnapshotPolicy(canonicalPath(workspace)))
		const excludedComponents = [
			".git",
			".pi",
			".wb",
			"node_modules",
			"dist",
			"build",
			"target",
			".next",
			".cache",
			"coverage",
			"__pycache__",
			".pytest_cache",
		] as const
		for (const component of excludedComponents) {
			for (const candidate of [path.join(workspace, component), path.join(workspace, "nested", component, "file")]) {
				assert.equal(
					evaluatePolicy(policy, { kind: "snapshot", path: canonicalPath(candidate) }).disposition,
					"exclude",
				)
				assert.equal(
					evaluatePolicy(snapshotOnlyPolicy, { kind: "snapshot", path: canonicalPath(candidate) }).disposition,
					"exclude",
				)
			}
		}
		for (const candidate of [path.join(workspace, "src", "index.ts"), path.join(workspace, ".env")]) {
			assert.equal(evaluatePolicy(policy, { kind: "snapshot", path: canonicalPath(candidate) }).disposition, "include")
		}
	})
})

test("the default policy expresses shared restrictions and sandbox capabilities in one rule list", () => {
	withTestTempDirectory("default-policy-subjects-", (root) => {
		const workspace = path.join(root, "workspace")
		const home = path.join(root, "home")
		const stateHome = path.join(root, "state")
		const piConfigDirectory = path.join(root, "pi-agent")
		const privateTemp = path.join(root, "tmp")
		const sshDirectory = path.join(home, ".ssh")
		for (const directory of [workspace, home, stateHome, piConfigDirectory, privateTemp, sshDirectory]) {
			fs.mkdirSync(directory, { recursive: true })
		}
		const readableSshFiles = [
			path.join(sshDirectory, "id_ed25519.pub"),
			path.join(sshDirectory, "nested", "deploy.pub"),
			path.join(sshDirectory, "config"),
			path.join(sshDirectory, "config.d", "work"),
			path.join(sshDirectory, "known_hosts"),
			path.join(sshDirectory, "known_hosts.old"),
			path.join(sshDirectory, "allowed_signers"),
			path.join(sshDirectory, "authorized_keys"),
		]
		const privateKey = canonicalPath(path.join(sshDirectory, "id_ed25519"))
		for (const file of readableSshFiles) {
			fs.mkdirSync(path.dirname(file), { recursive: true })
			fs.writeFileSync(file, "public metadata")
		}
		fs.writeFileSync(privateKey, "private material")
		const policy = unwrap(
			createDefaultPolicy({
				paths: {
					workspace: canonicalPath(workspace),
					home: canonicalPath(home),
					stateHome: canonicalPath(stateHome),
					piConfigDirectory: canonicalPath(piConfigDirectory),
				},
				additionalNoAccessPatterns: [],
				sandbox: {
					kind: "enabled",
					privateTemp: canonicalPath(privateTemp),
					integrations: {
						gitExecutable: canonicalExecutable("/usr/bin/git"),
						nix: { kind: "disabled" },
						sshAgent: { kind: "disabled" },
						docker: { kind: "disabled" },
						wb: { kind: "disabled" },
					},
				},
			}),
		)

		assert.equal(
			evaluatePolicy(policy, {
				kind: "file-access",
				operation: "write",
				subject: { kind: "builtin" },
				path: canonicalPath(path.join(privateTemp, "builtin.txt")),
			}).effect,
			"deny",
		)
		assert.equal(
			evaluatePolicy(policy, {
				kind: "file-access",
				operation: "write",
				subject: { kind: "sandbox" },
				path: canonicalPath(path.join(privateTemp, "bash.txt")),
			}).effect,
			"allow",
		)
		for (const subject of [{ kind: "builtin" }, { kind: "sandbox" }] as const) {
			for (const readable of readableSshFiles) {
				assert.equal(
					evaluatePolicy(policy, {
						kind: "file-access",
						operation: "read",
						subject,
						path: canonicalPath(readable),
					}).effect,
					"allow",
					readable,
				)
			}
			assert.equal(
				evaluatePolicy(policy, { kind: "file-access", operation: "read", subject, path: privateKey }).effect,
				"deny",
			)
		}

		const profile = emitSeatbelt(policy)
		for (const readable of readableSshFiles) {
			const publicRead = runWithSeatbeltProfile(profile, "/bin/cat", [readable], workspace)
			assert.equal(publicRead.status, 0, `${readable}: ${publicRead.stderr}`)
			assert.equal(publicRead.stdout, "public metadata")
		}
		assertDenied(runWithSeatbeltProfile(profile, "/bin/cat", [privateKey], workspace))
	})
})

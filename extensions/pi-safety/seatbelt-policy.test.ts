import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { createDefaultPolicy } from "./default-policy"
import { definePolicy, readOnly, readWrite, shared, tree } from "./policy"
import { unwrap } from "./result"
import { emitSeatbelt } from "./seatbelt"
import { canonicalExecutable, canonicalPath } from "./test-domain-values"
import { assertDenied, runWithSeatbeltProfile as runWithSeatbelt } from "./test-seatbelt"
import { withTestTempDirectory } from "./test-temp-directory"

function installedGit() {
	const git = Bun.which("git")
	if (!git) throw new Error("Git must be installed for Seatbelt policy tests")
	return canonicalExecutable(git)
}

function disabledIntegrations() {
	return {
		gitExecutable: installedGit(),
		sshAgent: { kind: "disabled" },
		docker: { kind: "disabled" },
		wb: { kind: "disabled" },
	} as const
}

function fixture(root: string) {
	const workspace = path.join(root, "workspace")
	const home = path.join(root, "home")
	const privateTemp = path.join(root, "tmp")
	const stateHome = path.join(root, "state")
	const piConfigDirectory = path.join(root, "pi-agent")
	for (const directory of [workspace, home, privateTemp, stateHome, piConfigDirectory]) fs.mkdirSync(directory)
	const policy = unwrap(
		createDefaultPolicy({
			paths: {
				workspace: canonicalPath(workspace),
				home: canonicalPath(home),
				stateHome: canonicalPath(stateHome),
				piConfigDirectory: canonicalPath(piConfigDirectory),
			},
			additionalNoAccessPatterns: [],
			sandbox: { kind: "enabled", privateTemp: canonicalPath(privateTemp), integrations: disabledIntegrations() },
		}),
	)
	return { workspace, home, privateTemp, stateHome, compiled: emitSeatbelt(policy), policy }
}

test("Seatbelt permits workspace workflows and sandbox-only temporary files", () => {
	withTestTempDirectory("seatbelt-policy-workspace-", (root) => {
		const value = fixture(root)
		const command = [
			"printf workspace > ordinary.txt",
			`printf temporary > ${JSON.stringify(path.join(value.privateTemp, "temporary.txt"))}`,
			"mv ordinary.txt renamed.txt",
			"rm renamed.txt",
		].join(" && ")
		const result = runWithSeatbelt(value.compiled, "/bin/bash", ["-c", command], value.workspace)
		assert.equal(result.status, 0, result.stderr)
		assert.equal(fs.readFileSync(path.join(value.privateTemp, "temporary.txt"), "utf8"), "temporary")
	})
})

test("Seatbelt preserves later writable exceptions under read-only parents", () => {
	withTestTempDirectory("seatbelt-policy-rule-order-", (root) => {
		const value = fixture(root)
		const protectedDirectory = path.join(value.workspace, "protected")
		const writableChild = path.join(protectedDirectory, "generated")
		fs.mkdirSync(writableChild, { recursive: true })
		const runtimeStart = value.policy.rules.findIndex((rule) => rule.kind !== "file-access" && rule.kind !== "snapshot")
		assert.notEqual(runtimeStart, -1)
		const policy = definePolicy({
			workspaceRoot: value.policy.workspaceRoot,
			homeRoot: value.policy.homeRoot,
			rules: [
				...value.policy.rules.slice(0, runtimeStart),
				readOnly(shared(), tree(canonicalPath(protectedDirectory))),
				readWrite(shared(), tree(canonicalPath(writableChild))),
				...value.policy.rules.slice(runtimeStart),
			],
		})
		const compiled = emitSeatbelt(policy)
		assertDenied(runWithSeatbelt(compiled, "/bin/bash", ["-c", "printf denied > protected/denied"], value.workspace))
		const allowed = runWithSeatbelt(
			compiled,
			"/bin/bash",
			["-c", "printf allowed > protected/generated/file && mv protected/generated/file protected/generated/moved"],
			value.workspace,
		)
		assert.equal(allowed.status, 0, allowed.stderr)
	})
})

test("Seatbelt keeps HOME read-only and protects secrets and safety state", () => {
	withTestTempDirectory("seatbelt-policy-denials-", (root) => {
		const value = fixture(root)
		const secret = path.join(value.workspace, ".env")
		fs.writeFileSync(secret, "TOKEN=secret")
		assertDenied(runWithSeatbelt(value.compiled, "/bin/cat", [secret], value.workspace))
		assertDenied(
			runWithSeatbelt(
				value.compiled,
				"/bin/bash",
				["-c", `printf replacement > ${JSON.stringify(secret)}`],
				value.workspace,
			),
		)
		assert.equal(fs.readFileSync(secret, "utf8"), "TOKEN=secret")
		for (const deniedFile of [path.join(value.home, "bad"), path.join(value.stateHome, "bad")]) {
			assertDenied(
				runWithSeatbelt(
					value.compiled,
					"/bin/bash",
					["-c", `printf bad > ${JSON.stringify(deniedFile)}`],
					value.workspace,
				),
			)
		}
	})
})

test("native wb grants remain scoped to the wb executable", () => {
	withTestTempDirectory("seatbelt-policy-wb-scope-", (root) => {
		const workspace = path.join(root, "workspace")
		const home = path.join(root, "home")
		const privateTemp = path.join(root, "tmp")
		const stateHome = path.join(root, "state")
		const piConfigDirectory = path.join(root, "pi-agent")
		const webKitState = path.join(home, "Library", "WebKit", "wb")
		const cacheState = path.join(home, "Library", "Caches", "wb")
		for (const directory of [workspace, privateTemp, stateHome, piConfigDirectory, webKitState, cacheState]) {
			fs.mkdirSync(directory, { recursive: true })
		}
		const integrations = {
			gitExecutable: installedGit(),
			sshAgent: { kind: "disabled" },
			docker: { kind: "disabled" },
			wb: {
				kind: "enabled",
				executable: canonicalExecutable("/bin/bash"),
				runtimeDirectory: canonicalPath(privateTemp),
				socket: canonicalPath(path.join(privateTemp, "wb.sock")),
				log: canonicalPath(path.join(privateTemp, "wb.log")),
				webKitState: canonicalPath(webKitState),
				cacheState: canonicalPath(cacheState),
			},
		} as const
		const policy = unwrap(
			createDefaultPolicy({
				paths: {
					workspace: canonicalPath(workspace),
					home: canonicalPath(home),
					stateHome: canonicalPath(stateHome),
					piConfigDirectory: canonicalPath(piConfigDirectory),
				},
				additionalNoAccessPatterns: [],
				sandbox: { kind: "enabled", privateTemp: canonicalPath(privateTemp), integrations },
			}),
		)
		const compiled = emitSeatbelt(policy)
		const allowedFile = path.join(webKitState, "allowed")
		const allowed = runWithSeatbelt(
			compiled,
			"/bin/bash",
			["-c", `printf allowed > ${JSON.stringify(allowedFile)}`],
			workspace,
		)
		assert.equal(allowed.status, 0, allowed.stderr)
		const deniedFile = path.join(webKitState, "denied")
		assertDenied(
			runWithSeatbelt(
				compiled,
				"/usr/bin/python3",
				["-c", `open(${JSON.stringify(deniedFile)}, 'w').write('denied')`],
				workspace,
			),
		)
		assert.equal(fs.existsSync(deniedFile), false)
		assert.ok(compiled.parameters.some((parameter) => parameter.value === "com.apple.nsurlsessiond"))
	})
})

test("Seatbelt preserves ordinary Git working-tree operations", () => {
	withTestTempDirectory("seatbelt-policy-git-", (root) => {
		const value = fixture(root)
		const command = [
			"git init -q",
			"git config pi-safety.test true",
			"printf tracked > tracked.txt",
			"git add tracked.txt",
			"git -c user.name=Pi -c user.email=pi@example.invalid commit -qm initial",
			"printf changed > tracked.txt",
			"git checkout -- tracked.txt",
			'test "$(cat tracked.txt)" = tracked',
			"printf changed > tracked.txt",
			"git restore tracked.txt",
			'test "$(cat tracked.txt)" = tracked',
			"printf changed > tracked.txt",
			"git reset --hard -q HEAD",
			"printf untracked > untracked.txt",
			"git clean -fdq",
			"test ! -e untracked.txt",
		].join(" && ")
		const result = runWithSeatbelt(value.compiled, "/bin/bash", ["-c", command], value.workspace)
		assert.equal(result.status, 0, result.stderr)
		assert.equal(fs.existsSync(path.join(value.workspace, ".git", "index")), true)
		assert.equal(fs.readFileSync(path.join(value.workspace, "tracked.txt"), "utf8"), "tracked")
		assert.match(fs.readFileSync(path.join(value.workspace, ".git", "config"), "utf8"), /pi-safety/)
		assertDenied(
			runWithSeatbelt(value.compiled, "/bin/bash", ["-c", "printf malicious > .git/config"], value.workspace),
		)
		assertDenied(runWithSeatbelt(value.compiled, "/bin/bash", ["-c", "mv .git moved-git"], value.workspace))
		assert.equal(fs.existsSync(path.join(value.workspace, ".git")), true)
	})
})

test("Seatbelt runs installed language and developer toolchains", () => {
	withTestTempDirectory("seatbelt-policy-toolchains-", (root) => {
		const value = fixture(root)
		const node = Bun.which("node")
		const bun = Bun.which("bun")
		const docker = Bun.which("docker")
		const pi = Bun.which("pi")
		if (!node || !bun || !docker || !pi) {
			throw new Error("Node, Bun, Docker, and Pi must be installed for the toolchain policy test")
		}
		for (const command of [
			["/usr/bin/git", "--version"],
			[node, "--version"],
			[bun, "--version"],
			[docker, "--version"],
			[pi, "--version"],
			["/usr/bin/python3", "--version"],
			["/usr/bin/ssh", "-V"],
			["/usr/bin/open", "-Ra", "Finder"],
		] as const) {
			const result = runWithSeatbelt(value.compiled, command[0], command.slice(1), value.workspace)
			assert.equal(result.status, 0, `${command.join(" ")}: ${result.stderr}`)
		}
	})
})

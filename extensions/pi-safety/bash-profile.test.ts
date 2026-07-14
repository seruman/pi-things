import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { compileBashProfile } from "./bash-profile"
import { canonicalExecutable, canonicalPath, protectedPattern, testBuiltinAccessPolicy } from "./test-domain-values"
import { assertDenied, runWithSeatbeltProfile as runWithSeatbelt } from "./test-seatbelt"
import { withTestTempDirectory } from "./test-temp-directory"

function installedGit() {
	const git = Bun.which("git")
	if (!git) throw new Error("Git must be installed for Bash profile tests")
	return canonicalExecutable(git)
}

function fixture(root: string) {
	const workspace = path.join(root, "workspace")
	const home = path.join(root, "home")
	const privateTemp = path.join(root, "tmp")
	const extensionState = path.join(root, "state")
	for (const directory of [workspace, home, privateTemp, extensionState]) fs.mkdirSync(directory)
	const canonicalWorkspace = canonicalPath(workspace)
	const gitWritePatterns = [
		protectedPattern(path.join(workspace, ".git", "hooks"), canonicalWorkspace),
		protectedPattern(path.join(workspace, ".git", "config"), canonicalWorkspace),
		protectedPattern(path.join(workspace, ".git", "config.worktree"), canonicalWorkspace),
	]
	const policy = testBuiltinAccessPolicy(workspace, home, {
		secretPatterns: [protectedPattern(path.join(workspace, "**", ".env*"), canonicalWorkspace)],
		gitWritePatterns,
		immutableWriteRoots: [canonicalPath(extensionState)],
	})
	return {
		workspace,
		home,
		privateTemp,
		extensionState,
		compiled: compileBashProfile({
			policy,
			privateTemp: canonicalPath(privateTemp),
			integrations: {
				gitExecutable: installedGit(),
				sshAgent: { kind: "disabled" },
				docker: { kind: "disabled" },
				wb: { kind: "disabled" },
			},
		}),
	}
}

test("Bash profile permits normal workspace workflows and private temporary files", () => {
	withTestTempDirectory("bash-profile-workspace-", (root) => {
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

test("Bash profile keeps HOME read-only and protects secrets and extension state", () => {
	withTestTempDirectory("bash-profile-denials-", (root) => {
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
		assertDenied(
			runWithSeatbelt(
				value.compiled,
				"/bin/bash",
				["-c", `printf bad > ${JSON.stringify(path.join(value.home, "bad"))}`],
				value.workspace,
			),
		)
		assertDenied(
			runWithSeatbelt(
				value.compiled,
				"/bin/bash",
				["-c", `printf bad > ${JSON.stringify(path.join(value.extensionState, "bad"))}`],
				value.workspace,
			),
		)
	})
})

test("native wb grants remain scoped to the wb executable", () => {
	withTestTempDirectory("bash-profile-wb-scope-", (root) => {
		const workspace = path.join(root, "workspace")
		const home = path.join(root, "home")
		const privateTemp = path.join(root, "tmp")
		const webKitState = path.join(home, "Library", "WebKit", "wb")
		const cacheState = path.join(home, "Library", "Caches", "wb")
		for (const directory of [workspace, privateTemp, webKitState, cacheState])
			fs.mkdirSync(directory, { recursive: true })
		const policy = testBuiltinAccessPolicy(workspace, home)
		const compiled = compileBashProfile({
			policy,
			privateTemp: canonicalPath(privateTemp),
			integrations: {
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
			},
		})
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

test("Bash profile preserves ordinary Git working-tree operations", () => {
	withTestTempDirectory("bash-profile-git-", (root) => {
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

test("Bash profile runs the installed language and developer toolchains", () => {
	withTestTempDirectory("bash-profile-toolchains-", (root) => {
		const value = fixture(root)
		const node = Bun.which("node")
		const bun = Bun.which("bun")
		const docker = Bun.which("docker")
		const pi = Bun.which("pi")
		if (!node || !bun || !docker || !pi) {
			throw new Error("Node, Bun, Docker, and Pi must be installed for the toolchain profile test")
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

import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import {
	allowRuntime,
	definePolicy,
	evaluatePolicy,
	executable,
	noAccess,
	pattern,
	readOnly,
	readWrite,
	shared,
	tree,
} from "./policy"
import { emitSeatbelt } from "./seatbelt"
import { canonicalExecutable, canonicalPath, pathPattern } from "./test-domain-values"
import { assertDenied, runWithSeatbeltProfile } from "./test-seatbelt"
import { withTestTempDirectory } from "./test-temp-directory"

test("movement protection blocks protected paths and ancestors without blocking workspace renames", () => {
	withTestTempDirectory("policy-movement-", (root) => {
		const home = path.join(root, "home")
		const workspace = path.join(home, "workspace")
		const outside = path.join(root, "outside")
		fs.mkdirSync(workspace, { recursive: true })
		fs.mkdirSync(outside)
		fs.writeFileSync(path.join(workspace, "ordinary.txt"), "ordinary")
		fs.writeFileSync(path.join(workspace, "safe-source.txt"), "safe")
		fs.writeFileSync(path.join(workspace, ".env"), "secret")
		fs.mkdirSync(path.join(workspace, "nested"))
		fs.writeFileSync(path.join(workspace, "nested", "api.key"), "secret")

		const canonicalRoot = canonicalPath(root)
		const policy = definePolicy({
			workspaceRoot: canonicalPath(workspace),
			homeRoot: canonicalPath(home),
			rules: [
				readOnly(shared(), tree(canonicalPath("/"))),
				readWrite(shared(), tree(canonicalPath(workspace))),
				noAccess(shared(), pattern(pathPattern(path.join(workspace, ".env"), canonicalRoot))),
				noAccess(shared(), pattern(pathPattern(path.join(workspace, ".secrets", "credentials"), canonicalRoot))),
				noAccess(shared(), pattern(pathPattern(path.join(workspace, "**", "*.key"), canonicalRoot))),
				allowRuntime(["process-exec", "sysctl-read"]),
			],
		})
		const compiled = emitSeatbelt(policy)

		assert.equal(
			evaluatePolicy(policy, {
				kind: "file-access",
				operation: "movement",
				subject: { kind: "sandbox" },
				path: canonicalPath(workspace),
			}).effect,
			"deny",
		)
		assert.equal(
			evaluatePolicy(policy, {
				kind: "file-access",
				operation: "movement",
				subject: { kind: "sandbox" },
				path: canonicalPath(path.join(workspace, "ordinary.txt")),
			}).effect,
			"allow",
		)

		const ordinarySource = path.join(workspace, "ordinary.txt")
		const ordinaryDestination = path.join(workspace, "renamed.txt")
		const ordinaryMove = runWithSeatbeltProfile(compiled, "/bin/mv", [ordinarySource, ordinaryDestination])
		assert.equal(ordinaryMove.status, 0, ordinaryMove.stderr)
		assert.equal(fs.readFileSync(ordinaryDestination, "utf8"), "ordinary")

		const envSource = path.join(workspace, ".env")
		const envDestination = path.join(workspace, ".env.moved")
		assertDenied(runWithSeatbeltProfile(compiled, "/bin/mv", [envSource, envDestination]))
		assert.equal(fs.readFileSync(envSource, "utf8"), "secret")

		const keySource = path.join(workspace, "nested", "api.key")
		const keyDestination = path.join(workspace, "nested", "api.key.moved")
		assertDenied(runWithSeatbeltProfile(compiled, "/bin/mv", [keySource, keyDestination]))
		assert.equal(fs.readFileSync(keySource, "utf8"), "secret")

		const safeSource = path.join(workspace, "safe-source.txt")
		const protectedDestination = path.join(workspace, "nested", "new.key")
		assertDenied(runWithSeatbeltProfile(compiled, "/bin/mv", [safeSource, protectedDestination]))
		assert.equal(fs.readFileSync(safeSource, "utf8"), "safe")
		assert.equal(fs.existsSync(protectedDestination), false)

		const workspaceDestination = path.join(home, "workspace-moved")
		assertDenied(runWithSeatbeltProfile(compiled, "/bin/mv", [workspace, workspaceDestination]))
		assert.equal(fs.existsSync(workspace), true)

		const missingAncestor = path.join(workspace, ".secrets")
		assertDenied(runWithSeatbeltProfile(compiled, "/bin/ln", ["-s", outside, missingAncestor]))
		assert.equal(fs.existsSync(missingAncestor), false)
	})
})

test("an executable exception overrides movement protection only for that executable", () => {
	withTestTempDirectory("policy-movement-executable-exception-", (root) => {
		const first = path.join(root, "first.txt")
		const second = path.join(root, "second.txt")
		const third = path.join(root, "third.txt")
		fs.writeFileSync(first, "excepted")
		const canonicalRoot = canonicalPath(root)
		const textFiles = pattern(pathPattern(path.join(root, "**", "*.txt"), canonicalRoot))
		const perl = canonicalExecutable("/usr/bin/perl")
		const policy = definePolicy({
			workspaceRoot: canonicalRoot,
			homeRoot: canonicalRoot,
			rules: [
				readOnly(shared(), tree(canonicalPath("/"))),
				readWrite(shared(), tree(canonicalRoot)),
				noAccess(shared(), textFiles),
				readWrite(executable(perl), textFiles),
				allowRuntime(["process-exec", "sysctl-read"]),
			],
		})
		const compiled = emitSeatbelt(policy)

		assertDenied(runWithSeatbeltProfile(compiled, "/bin/mv", [first, second]))
		assert.equal(fs.existsSync(first), true)
		const script = "rename $ARGV[0], $ARGV[1] or die $!"
		const allowed = runWithSeatbeltProfile(compiled, "/usr/bin/perl", ["-e", script, first, third])
		assert.equal(allowed.status, 0, allowed.stderr)
		assert.equal(fs.readFileSync(third, "utf8"), "excepted")
	})
})

test("an executable denial does not constrain other executables", () => {
	withTestTempDirectory("policy-movement-executable-denial-", (root) => {
		const first = path.join(root, "first.txt")
		const second = path.join(root, "second.txt")
		const third = path.join(root, "third.txt")
		fs.writeFileSync(first, "scoped")
		const canonicalRoot = canonicalPath(root)
		const textFiles = pattern(pathPattern(path.join(root, "**", "*.txt"), canonicalRoot))
		const policy = definePolicy({
			workspaceRoot: canonicalRoot,
			homeRoot: canonicalRoot,
			rules: [
				readOnly(shared(), tree(canonicalPath("/"))),
				readWrite(shared(), tree(canonicalRoot)),
				noAccess(executable(canonicalExecutable("/bin/mv")), textFiles),
				allowRuntime(["process-exec", "sysctl-read"]),
			],
		})
		const compiled = emitSeatbelt(policy)

		assertDenied(runWithSeatbeltProfile(compiled, "/bin/mv", [first, second]))
		const script = "rename $ARGV[0], $ARGV[1] or die $!"
		const allowed = runWithSeatbeltProfile(compiled, "/usr/bin/perl", ["-e", script, first, third])
		assert.equal(allowed.status, 0, allowed.stderr)
		assert.equal(fs.readFileSync(third, "utf8"), "scoped")
	})
})

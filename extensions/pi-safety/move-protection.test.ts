import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { pattern, tree } from "./file-policy"
import { movementRuleForSelector } from "./move-protection"
import { emitSbpl } from "./sbpl"
import { canonicalExecutable, canonicalPath, pathPattern } from "./test-domain-values"
import { assertDenied, runWithSeatbelt } from "./test-seatbelt"
import { withTestTempDirectory } from "./test-temp-directory"

test("emits movement effects in file-policy order", () => {
	withTestTempDirectory("pi-safety-move-", (root) => {
		const workspace = path.join(root, "workspace")
		fs.mkdirSync(workspace)
		const canonicalRoot = canonicalPath(root)
		const rules = [
			movementRuleForSelector({ scope: { kind: "sandbox" }, selector: tree(canonicalRoot), writable: false }),
			movementRuleForSelector({
				scope: { kind: "sandbox" },
				selector: tree(canonicalPath(workspace)),
				writable: true,
			}),
			movementRuleForSelector({
				scope: { kind: "sandbox" },
				selector: pattern(pathPattern(path.join(workspace, ".env"), canonicalRoot)),
				writable: false,
			}),
		]
		const effects = emitSbpl(rules).source.matchAll(/^\((allow|deny) /gm)
		assert.deepEqual(
			[...effects].map((match) => match[1]),
			["deny", "allow", "deny"],
		)
	})
})

test("blocks protected moves and missing-ancestor symlinks without blocking ordinary workspace renames", () => {
	withTestTempDirectory("pi-safety-move-", (root) => {
		const home = path.join(root, "home")
		const workspace = path.join(home, "workspace")
		const outside = path.join(root, "outside")
		fs.mkdirSync(workspace, { recursive: true })
		fs.mkdirSync(outside)
		fs.writeFileSync(path.join(workspace, "ordinary.txt"), "ordinary")
		fs.writeFileSync(path.join(workspace, ".env"), "secret")
		fs.mkdirSync(path.join(workspace, "nested"))
		fs.writeFileSync(path.join(workspace, "nested", "api.key"), "secret")

		const canonicalRoot = canonicalPath(root)
		const compiled = emitSbpl([
			movementRuleForSelector({
				scope: { kind: "sandbox" },
				selector: tree(canonicalPath(home)),
				writable: false,
			}),
			movementRuleForSelector({
				scope: { kind: "sandbox" },
				selector: tree(canonicalPath(workspace)),
				writable: true,
			}),
			...[
				pathPattern(path.join(workspace, ".env"), canonicalRoot),
				pathPattern(path.join(workspace, ".secrets", "credentials"), canonicalRoot),
				pathPattern(path.join(workspace, "**", "*.key"), canonicalRoot),
			].map((selector) =>
				movementRuleForSelector({
					scope: { kind: "sandbox" },
					selector: pattern(selector),
					writable: false,
				}),
			),
		])

		const ordinarySource = path.join(workspace, "ordinary.txt")
		const ordinaryDestination = path.join(workspace, "renamed.txt")
		const ordinaryMove = runWithSeatbelt(compiled, "/bin/mv", [ordinarySource, ordinaryDestination])
		assert.equal(ordinaryMove.status, 0, ordinaryMove.stderr)
		assert.equal(fs.existsSync(ordinarySource), false)
		assert.equal(fs.readFileSync(ordinaryDestination, "utf8"), "ordinary")

		const envSource = path.join(workspace, ".env")
		const envDestination = path.join(workspace, ".env.moved")
		assertDenied(runWithSeatbelt(compiled, "/bin/mv", [envSource, envDestination]))
		assert.equal(fs.readFileSync(envSource, "utf8"), "secret")
		assert.equal(fs.existsSync(envDestination), false)

		const keySource = path.join(workspace, "nested", "api.key")
		const keyDestination = path.join(workspace, "nested", "api.key.moved")
		assertDenied(runWithSeatbelt(compiled, "/bin/mv", [keySource, keyDestination]))
		assert.equal(fs.readFileSync(keySource, "utf8"), "secret")
		assert.equal(fs.existsSync(keyDestination), false)

		const workspaceDestination = path.join(home, "workspace-moved")
		assertDenied(runWithSeatbelt(compiled, "/bin/mv", [workspace, workspaceDestination]))
		assert.equal(fs.existsSync(workspace), true)
		assert.equal(fs.existsSync(workspaceDestination), false)

		const missingAncestor = path.join(workspace, ".secrets")
		assertDenied(runWithSeatbelt(compiled, "/bin/ln", ["-s", outside, missingAncestor]))
		assert.equal(fs.existsSync(missingAncestor), false)
	})
})

test("process-excepted movement rules deny every executable except the selected one", () => {
	withTestTempDirectory("pi-safety-move-except-scope-", (root) => {
		const first = path.join(root, "first.txt")
		const second = path.join(root, "second.txt")
		const third = path.join(root, "third.txt")
		fs.writeFileSync(first, "excepted")
		const canonicalRoot = canonicalPath(root)
		const compiled = emitSbpl([
			movementRuleForSelector({
				scope: { kind: "except-process", executable: canonicalExecutable(process.execPath) },
				selector: pattern(pathPattern(path.join(root, "**", "*.txt"), canonicalRoot)),
				writable: false,
			}),
		])

		assertDenied(runWithSeatbelt(compiled, "/bin/mv", [first, second]))
		assert.equal(fs.existsSync(first), true)
		const script = 'require("node:fs").renameSync(process.argv.at(-2), process.argv.at(-1))'
		const exceptedMove = runWithSeatbelt(compiled, process.execPath, ["-e", script, first, third])
		assert.equal(exceptedMove.status, 0, exceptedMove.stderr)
		assert.equal(fs.readFileSync(third, "utf8"), "excepted")
	})
})

test("process-scoped movement rules affect only the selected executable", () => {
	withTestTempDirectory("pi-safety-move-scope-", (root) => {
		const first = path.join(root, "first.txt")
		const second = path.join(root, "second.txt")
		const third = path.join(root, "third.txt")
		fs.writeFileSync(first, "scoped")
		const canonicalRoot = canonicalPath(root)
		const compiled = emitSbpl([
			movementRuleForSelector({
				scope: { kind: "process", executable: canonicalExecutable("/bin/mv") },
				selector: pattern(pathPattern(path.join(root, "**", "*.txt"), canonicalRoot)),
				writable: false,
			}),
		])

		assertDenied(runWithSeatbelt(compiled, "/bin/mv", [first, second]))
		assert.equal(fs.existsSync(first), true)
		assert.equal(fs.existsSync(second), false)

		const script = 'require("node:fs").renameSync(process.argv.at(-2), process.argv.at(-1))'
		const otherProcessMove = runWithSeatbelt(compiled, process.execPath, ["-e", script, first, third])
		assert.equal(otherProcessMove.status, 0, otherProcessMove.stderr)
		assert.equal(fs.existsSync(first), false)
		assert.equal(fs.readFileSync(third, "utf8"), "scoped")
	})
})

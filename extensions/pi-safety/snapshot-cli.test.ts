import { test } from "bun:test"
import assert from "node:assert/strict"
import * as path from "node:path"
import { parseSnapshotCommand, parseSnapshotInvocation } from "./snapshot-cli"
import { withTestTempDirectory } from "./test-temp-directory"

const id = "20260713213049840-206bc3b657fa7807"

test("parses legal snapshot CLI command shapes", () => {
	withTestTempDirectory("snapshot-cli-", (root) => {
		const destination = path.join(root, "export")
		const cases = [
			[["--help"], "help"],
			[[], "list"],
			[["list"], "list"],
			[["create"], "create"],
			[["diff", id], "diff"],
			[["diff", id, "--", "src/file.ts"], "diff"],
			[["show", id, "src/file.ts"], "show"],
			[["restore", id], "restore"],
			[["restore", id, "--dry-run"], "restore"],
			[["restore", id, "--apply"], "restore"],
			[["restore", id, "--", "src/file.ts", "deleted.txt"], "restore"],
			[["restore", id, "--dry-run", "--", "src/file.ts"], "restore"],
			[["restore", id, "--apply", "--", "src/file.ts"], "restore"],
			[["export", id, destination], "export"],
			[["verify", id], "verify"],
			[["gc"], "gc"],
		] as const
		for (const [args, kind] of cases) {
			const parsed = parseSnapshotCommand(args)
			assert.equal(parsed.ok, true, args.join(" "))
			if (parsed.ok) assert.equal(parsed.value.kind, kind)
		}
	})
})

test("parses an explicit project once and defaults restores to dry-run", () => {
	withTestTempDirectory("snapshot-cli-project-", (root) => {
		const parsed = parseSnapshotInvocation(["--project", root, "restore", id])
		assert.equal(parsed.ok, true)
		if (!parsed.ok) return
		assert.deepEqual(parsed.value.project, { kind: "explicit", root })
		assert.equal(parsed.value.command.kind, "restore")
		if (parsed.value.command.kind === "restore") assert.equal(parsed.value.command.execution, "dry-run")

		const apply = parseSnapshotInvocation(["--project", root, "restore", id, "--apply", "--", "file.txt"])
		assert.equal(apply.ok, true)
		if (apply.ok && apply.value.command.kind === "restore") {
			assert.equal(apply.value.command.execution, "apply")
		}
	})
})

test("rejects malformed IDs, paths, separators, and argument counts", () => {
	for (const args of [
		["create", "extra"],
		["diff", "bad-id"],
		["diff", id, "--"],
		["diff", id, "--", "../escape"],
		["show", id, "../escape"],
		["restore", id, "src/file.ts"],
		["restore", id, "--"],
		["restore", id, "--dry-run", "--"],
		["restore", id, "--apply", "--"],
		["restore", id, "--force"],
		["export", id, "relative"],
		["verify"],
		["unknown"],
	]) {
		assert.equal(parseSnapshotCommand(args).ok, false, args.join(" "))
	}
	assert.equal(parseSnapshotInvocation(["--project"]).ok, false)
	assert.equal(parseSnapshotInvocation(["--project", "/definitely/not/a/project", "list"]).ok, false)
})

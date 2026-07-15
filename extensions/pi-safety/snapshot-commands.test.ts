import { test } from "bun:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { createSnapshotFilePolicy } from "./default-rules"
import { unwrap } from "./result"
import { createSnapshot, createSnapshotStore } from "./snapshot"
import { parseSnapshotCommand } from "./snapshot-cli"
import { runSnapshotCommand } from "./snapshot-commands"
import { canonicalPath } from "./test-domain-values"
import { withTestTempDirectory } from "./test-temp-directory"

function fixture(root: string) {
	const workspace = path.join(root, "workspace")
	const state = path.join(root, "state")
	fs.mkdirSync(workspace)
	fs.mkdirSync(state)
	fs.writeFileSync(path.join(workspace, "file.txt"), "before")
	const workspaceRoot = canonicalPath(workspace)
	const store = unwrap(
		createSnapshotStore({
			workspaceRoot,
			stateRoot: canonicalPath(state),
			filePolicy: unwrap(createSnapshotFilePolicy(workspaceRoot)),
		}),
	)
	const snapshot = unwrap(createSnapshot(store))
	return { workspace, store, snapshot }
}

function command(args: readonly string[]) {
	return unwrap(parseSnapshotCommand(args))
}

test("snapshot commands list, show, diff, verify, restore, export, and collect", () => {
	withTestTempDirectory("snapshot-commands-", (root) => {
		const value = fixture(root)
		fs.writeFileSync(path.join(value.workspace, "file.txt"), "after-content")
		fs.writeFileSync(path.join(value.workspace, "added.txt"), "added")
		fs.mkdirSync(path.join(value.workspace, "node_modules"))
		const fifo = spawnSync("/usr/bin/mkfifo", [path.join(value.workspace, "runtime.fifo")], { encoding: "utf8" })
		assert.equal(fifo.status, 0, fifo.stderr)

		const listed = unwrap(runSnapshotCommand(value.store, command(["list"]), { kind: "sandboxed" }))
		assert.match(listed.split("\n")[0], /^ID +CREATED_AT +ENTRIES +RECLAIMABLE_BYTES +SESSION +WORKSPACE$/)
		assert.match(listed, new RegExp(`^${value.snapshot.id} +[^\\n]+ +- +standalone +${value.workspace}$`, "m"))
		assert.doesNotMatch(listed, /\t/)
		assert.equal(
			unwrap(runSnapshotCommand(value.store, command(["show", value.snapshot.id, "file.txt"]), { kind: "sandboxed" })),
			"before",
		)
		const diff = unwrap(runSnapshotCommand(value.store, command(["diff", value.snapshot.id]), { kind: "sandboxed" }))
		assert.match(diff, /modified\tfile\.txt/)
		assert.match(diff, /added\tadded\.txt/)
		assert.match(diff, /excluded\tnode_modules/)
		assert.match(diff, /non-comparable\truntime\.fifo\tfifo/)
		const textDiff = unwrap(
			runSnapshotCommand(value.store, command(["diff", value.snapshot.id, "--", "file.txt"]), {
				kind: "sandboxed",
			}),
		)
		assert.match(textDiff, /--- snapshot\/file\.txt/)
		assert.match(textDiff, /\+\+\+ live\/file\.txt/)
		assert.match(textDiff, /-before/)
		assert.match(textDiff, /\+after-content/)
		fs.rmSync(path.join(value.workspace, "runtime.fifo"))
		assert.match(
			unwrap(runSnapshotCommand(value.store, command(["verify", value.snapshot.id]), { kind: "sandboxed" })),
			/verified/,
		)
		const dryRun = unwrap(
			runSnapshotCommand(value.store, command(["restore", value.snapshot.id, "--dry-run", "--", "file.txt"]), {
				kind: "sandboxed",
			}),
		)
		assert.match(dryRun, /file\tfile\.txt/)
		assert.equal(fs.readFileSync(path.join(value.workspace, "file.txt"), "utf8"), "after-content")

		unwrap(
			runSnapshotCommand(value.store, command(["restore", value.snapshot.id, "--apply", "--", "file.txt"]), {
				kind: "sandboxed",
			}),
		)
		assert.equal(fs.readFileSync(path.join(value.workspace, "file.txt"), "utf8"), "before")
		assert.equal(fs.existsSync(path.join(value.workspace, "added.txt")), true)

		const destination = path.join(root, "exported")
		unwrap(runSnapshotCommand(value.store, command(["export", value.snapshot.id, destination]), { kind: "sandboxed" }))
		assert.equal(fs.readFileSync(path.join(destination, "file.txt"), "utf8"), "before")
		assert.equal(unwrap(runSnapshotCommand(value.store, command(["gc"]), { kind: "sandboxed" })), "gc complete")
	})
})

test("diff compares bytes when file metadata is unchanged", () => {
	withTestTempDirectory("snapshot-command-content-diff-", (root) => {
		const value = fixture(root)
		const manifest = JSON.parse(fs.readFileSync(path.join(value.snapshot.directory, "manifest.json"), "utf8"))
		const entry = manifest.entries.find((candidate: { path: string }) => candidate.path === "file.txt")
		if (!entry) throw new Error("snapshot file entry missing")
		const liveFile = path.join(value.workspace, "file.txt")
		fs.writeFileSync(liveFile, "BEFORE")
		fs.utimesSync(liveFile, entry.mtimeMs / 1000, entry.mtimeMs / 1000)
		assert.equal(fs.statSync(liveFile).mtimeMs, entry.mtimeMs)
		const diff = unwrap(runSnapshotCommand(value.store, command(["diff", value.snapshot.id]), { kind: "sandboxed" }))
		assert.match(diff, /modified\tfile\.txt/)
	})
})

test("direct restore creates a redo checkpoint before mutation", () => {
	withTestTempDirectory("snapshot-command-redo-", (root) => {
		const value = fixture(root)
		fs.writeFileSync(path.join(value.workspace, "file.txt"), "redo-state")
		unwrap(
			runSnapshotCommand(value.store, command(["restore", value.snapshot.id, "--apply"]), {
				kind: "direct-user",
			}),
		)
		assert.equal(fs.readFileSync(path.join(value.workspace, "file.txt"), "utf8"), "before")
		const snapshots = fs
			.readdirSync(value.store.projectDirectory, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		assert.equal(snapshots.length, 2)
	})
})

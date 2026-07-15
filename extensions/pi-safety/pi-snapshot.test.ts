import { test } from "bun:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { withTestTempDirectory } from "./test-temp-directory"

function runCli(cwd: string, env: NodeJS.ProcessEnv, args: readonly string[]) {
	const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "pi-snapshot.ts")
	return spawnSync(script, [...args], { cwd, env, encoding: "utf8", timeout: 30_000 })
}

test("standalone pi-snapshot creates, lists, shows, and restores in isolated XDG state", () => {
	withTestTempDirectory("pi-snapshot-cli-", (root) => {
		const workspace = path.join(root, "workspace")
		const home = path.join(root, "home")
		const state = path.join(root, "state")
		const temp = path.join(root, "tmp")
		const piConfig = path.join(root, "pi-config")
		const administration = path.join(root, "administration")
		for (const directory of [workspace, home, state, temp, piConfig, administration]) fs.mkdirSync(directory)
		const file = path.join(workspace, "file.txt")
		fs.writeFileSync(file, "before")
		const env = {
			PATH: process.env.PATH,
			HOME: home,
			XDG_STATE_HOME: state,
			TMPDIR: temp,
			PI_CODING_AGENT_DIR: piConfig,
		}

		const project = ["--project", workspace]
		const created = runCli(administration, env, [...project, "create"])
		assert.equal(created.status, 0, created.stderr)
		const id = created.stdout.trim()
		assert.match(id, /^\d{17}-[0-9a-f]{16}$/)
		const listed = runCli(administration, env, [...project, "list"])
		assert.equal(listed.status, 0, listed.stderr)
		assert.match(listed.stdout, /^ID +CREATED_AT +ENTRIES +RECLAIMABLE_BYTES +SESSION +WORKSPACE\n/)
		assert.match(listed.stdout, new RegExp(`${id} +[^\\n]+ +\\d+ +standalone +${workspace}`))
		assert.doesNotMatch(listed.stdout, /\t/)
		const shown = runCli(administration, env, [...project, "show", id, "file.txt"])
		assert.equal(shown.status, 0, shown.stderr)
		assert.equal(shown.stdout, "before\n")

		fs.writeFileSync(file, "after")
		const secondCreated = runCli(administration, env, [...project, "create"])
		assert.equal(secondCreated.status, 0, secondCreated.stderr)
		const secondId = secondCreated.stdout.trim()
		const compared = runCli(administration, env, [...project, "diff", id, secondId, "--", "file.txt"])
		assert.equal(compared.status, 0, compared.stderr)
		assert.match(compared.stdout, new RegExp(`--- ${id}/file\\.txt`))
		assert.match(compared.stdout, new RegExp(`\\+\\+\\+ ${secondId}/file\\.txt`))

		const dryRun = runCli(administration, env, [...project, "restore", id, "--", "file.txt"])
		assert.equal(dryRun.status, 0, dryRun.stderr)
		assert.match(dryRun.stdout, /file\tfile\.txt/)
		assert.equal(fs.readFileSync(file, "utf8"), "after")
		const restored = runCli(administration, env, [...project, "restore", id, "--apply", "--", "file.txt"])
		assert.equal(restored.status, 0, restored.stderr)
		assert.equal(fs.readFileSync(file, "utf8"), "before")
	})
})

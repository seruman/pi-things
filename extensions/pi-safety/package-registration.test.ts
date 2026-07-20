import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

function readJson(pathname: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(pathname, "utf8"))
}

test("package activates Pi safety alongside the standalone shell guard", () => {
	const manifest = readJson(path.join(repository, "package.json")) as {
		pi: { extensions: string[] }
		bin: Record<string, string>
	}
	assert.ok(manifest.pi.extensions.includes("./extensions/pi-safety/index.ts"))
	assert.equal(manifest.pi.extensions.includes("./extensions/shell-leash/index.ts"), true)
	assert.equal(manifest.pi.extensions.includes("./extensions/secret-guard/index.ts"), false)
	assert.equal(manifest.bin["pi-snapshot"], "./extensions/pi-safety/pi-snapshot.ts")
	const snapshotExecutable = path.join(repository, manifest.bin["pi-snapshot"])
	assert.notEqual(fs.statSync(snapshotExecutable).mode & 0o111, 0)
	assert.match(fs.readFileSync(snapshotExecutable, "utf8"), /^#!\/usr\/bin\/env -S bun --no-env-file\n/)
	assert.equal(fs.existsSync(path.join(repository, "extensions", "shell-leash", "index.ts")), true)
	assert.equal(fs.existsSync(path.join(repository, "extensions", "secret-guard")), false)
	const subagentSource = fs.readFileSync(path.join(repository, "extensions", "subagent-tools", "index.ts"), "utf8")
	assert.match(subagentSource, /"pi-safety", "index\.ts"/)
	assert.doesNotMatch(subagentSource, /"secret-guard"/)
})

test("Pi SDK dependencies exactly match the installed Pi release used for Bash parity", () => {
	const manifest = readJson(path.join(repository, "package.json")) as {
		devDependencies: Record<string, string>
	}
	const sdkManifest = readJson(
		path.join(repository, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
	) as { version: string }
	assert.equal(sdkManifest.version, "0.80.5")
	for (const dependency of [
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
	]) {
		assert.equal(manifest.devDependencies[dependency], sdkManifest.version)
	}
})

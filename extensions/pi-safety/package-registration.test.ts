import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

const packageManifestSchema = z.object({
	pi: z.object({ extensions: z.array(z.string()) }),
	bin: z.record(z.string()),
})

test("package activates Pi safety alongside the standalone shell guard", () => {
	const manifest = packageManifestSchema.parse(
		JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8")),
	)

	assert.ok(manifest.pi.extensions.includes("./extensions/pi-safety/index.ts"))
	assert.equal(manifest.pi.extensions.includes("./extensions/shell-leash/index.ts"), true)
	assert.equal(manifest.pi.extensions.includes("./extensions/secret-guard/index.ts"), false)
	assert.equal(manifest.bin["pi-snapshot"], "./extensions/pi-safety/pi-snapshot.ts")
	const snapshotExecutable = path.join(repository, manifest.bin["pi-snapshot"])
	assert.notEqual(fs.statSync(snapshotExecutable).mode & 0o111, 0)
	assert.match(fs.readFileSync(snapshotExecutable, "utf8"), /^#!\/usr\/bin\/env -S bun --no-env-file\n/)
	assert.equal(fs.existsSync(path.join(repository, "extensions", "shell-leash", "index.ts")), true)
})

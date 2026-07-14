import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import {
	appendCanonicalPath,
	parseCanonicalExecutable,
	parseCanonicalPath,
	parseLexicalAbsolutePath,
	seatbeltPathAliases,
} from "./canonical-path"
import { unwrap } from "./result"
import { withTestTempDirectory } from "./test-temp-directory"

test("canonicalizes existing paths and symlinked ancestors", () => {
	withTestTempDirectory("pi-safety-path-", (root) => {
		const real = path.join(root, "real")
		const link = path.join(root, "link")
		fs.mkdirSync(real)
		fs.symlinkSync(real, link)

		assert.equal(unwrap(parseCanonicalPath(link)), fs.realpathSync.native(real))
		assert.equal(
			unwrap(parseCanonicalPath(path.join(link, "missing", "child"))),
			path.join(fs.realpathSync.native(real), "missing", "child"),
		)
	})
})

test("rejects relative paths, NUL bytes, and dangling symlinks", () => {
	const relative = parseCanonicalPath("relative/path")
	assert.equal(relative.ok, false)
	if (!relative.ok) assert.equal(relative.error.kind, "not-absolute")

	const nul = parseCanonicalPath("/tmp/nul\0path")
	assert.equal(nul.ok, false)
	if (!nul.ok) assert.equal(nul.error.kind, "nul-byte")

	withTestTempDirectory("pi-safety-path-", (root) => {
		const dangling = path.join(root, "dangling")
		fs.symlinkSync(path.join(root, "missing-target"), dangling)
		const parsed = parseCanonicalPath(path.join(dangling, "child"))
		assert.equal(parsed.ok, false)
		if (!parsed.ok) assert.equal(parsed.error.kind, "dangling-symlink")
	})
})

test("appends parsed relative components without consulting the child filesystem", () => {
	withTestTempDirectory("canonical-append-", (root) => {
		const canonicalRoot = unwrap(parseCanonicalPath(root))
		assert.deepEqual(appendCanonicalPath(canonicalRoot, ["missing", "child.txt"]), {
			ok: true,
			value: path.join(root, "missing", "child.txt"),
		})
		assert.equal(appendCanonicalPath(canonicalRoot, [".."]).ok, false)
		assert.equal(appendCanonicalPath(canonicalRoot, ["nested/escape"]).ok, false)
	})
})

test("derives typed Seatbelt aliases for macOS /private paths", () => {
	const canonical = unwrap(parseCanonicalPath("/private/tmp/pi-safety.sock"))
	assert.deepEqual(seatbeltPathAliases(canonical), [unwrap(parseLexicalAbsolutePath("/tmp/pi-safety.sock"))])
	assert.equal(parseLexicalAbsolutePath("relative").ok, false)
})

test("distinguishes canonical executable paths", () => {
	const executable = parseCanonicalExecutable("/usr/bin/true")
	assert.equal(executable.ok, true)

	withTestTempDirectory("pi-safety-executable-", (root) => {
		const ordinaryFile = path.join(root, "ordinary")
		fs.writeFileSync(ordinaryFile, "not executable")
		const parsed = parseCanonicalExecutable(ordinaryFile)
		assert.equal(parsed.ok, false)
		if (!parsed.ok) assert.equal(parsed.error.kind, "not-executable")
	})
})

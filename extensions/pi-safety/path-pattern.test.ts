import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import type { PathPattern } from "./path-pattern"
import { parsePathPattern } from "./path-pattern"
import { unwrap } from "./result"
import { canonicalPath } from "./test-domain-values"
import { withTestTempDirectory } from "./test-temp-directory"

function globPattern(pattern: PathPattern): Extract<PathPattern, { kind: "glob" }> {
	if (pattern.kind !== "glob") assert.fail(`expected glob pattern, received ${pattern.kind}`)
	return pattern
}

test("parses literal paths relative to a canonical root", () => {
	withTestTempDirectory("pi-safety-pattern-", (root) => {
		const literalFile = path.join(root, "literal*.env")
		fs.writeFileSync(literalFile, "value")
		const parsed = unwrap(parsePathPattern("literal\\*.env", canonicalPath(root)))

		assert.equal(parsed.kind, "literal")
		if (parsed.kind === "literal") assert.equal(parsed.path, literalFile)
	})
})

test("canonicalizes a glob's static base and compiles it with the library", () => {
	withTestTempDirectory("pi-safety-pattern-", (root) => {
		const real = path.join(root, "real")
		const link = path.join(root, "link")
		fs.mkdirSync(real)
		fs.symlinkSync(real, link)

		const parsed = globPattern(unwrap(parsePathPattern("link/**/*.env", canonicalPath(root))))
		const canonicalReal = fs.realpathSync.native(real)
		const regex = new RegExp(parsed.regex)

		assert.equal(parsed.staticBase, canonicalReal)
		assert.equal(parsed.pattern, `${canonicalReal}/**/*.env`)
		assert.doesNotMatch(parsed.regex, /\(\?/)
		assert.equal(regex.test(path.join(canonicalReal, ".env")), true)
		assert.equal(regex.test(path.join(canonicalReal, "nested", "local.env")), true)
		assert.equal(regex.test(path.join(canonicalReal, "nested", "local.txt")), false)
	})
})

test("supports component wildcards and character classes", () => {
	withTestTempDirectory("pi-safety-pattern-", (root) => {
		const parsed = globPattern(unwrap(parsePathPattern("*/file[0-9]?.txt", canonicalPath(root))))
		const regex = new RegExp(parsed.regex)

		assert.equal(regex.test(path.join(root, "app", "file42.txt")), true)
		assert.equal(regex.test(path.join(root, "app", "file4.txt")), false)
		assert.equal(regex.test(path.join(root, "app", "nested", "file42.txt")), false)
	})
})

test("rejects patterns outside the intentionally supported subset", () => {
	withTestTempDirectory("pi-safety-pattern-", (root) => {
		const base = canonicalPath(root)
		for (const [input, kind] of [
			["/**/*.env", "glob-too-broad"],
			["foo\\*?.env", "unsupported-glob"],
			["*.{env,key}", "unsupported-glob"],
			["line\nbreak*", "unsupported-glob"],
		] as const) {
			const parsed = parsePathPattern(input, base)
			assert.equal(parsed.ok, false, input)
			if (!parsed.ok) assert.equal(parsed.error.kind, kind, input)
		}
	})
})

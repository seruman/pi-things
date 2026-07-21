import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { parseSessionPathGrant, parseSessionPathsEnvironment } from "./session-paths"
import { withTestTempDirectory } from "./test-temp-directory"

test("session paths parse interactive tilde and strict environment grants", () => {
	withTestTempDirectory("session-paths-", (root) => {
		const home = path.join(root, "home")
		const other = path.join(root, "other")
		fs.mkdirSync(home)
		fs.mkdirSync(other)

		assert.deepEqual(parseSessionPathGrant({ path: "~/", access: "read-only", home, allowTilde: true }), {
			ok: true,
			value: { path: home, access: "read-only" },
		})
		assert.deepEqual(parseSessionPathsEnvironment(JSON.stringify([{ path: other, access: "read-write" }]), home), {
			ok: true,
			value: [{ path: other, access: "read-write" }],
		})
		assert.equal(parseSessionPathsEnvironment('[{"path":"relative","access":"read-write"}]', home).ok, false)
		assert.equal(parseSessionPathsEnvironment("not-json", home).ok, false)
	})
})

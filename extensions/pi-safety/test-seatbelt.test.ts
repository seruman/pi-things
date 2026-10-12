import { test } from "bun:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { emitSbpl, fileRule, literal } from "./sbpl"
import { canonicalPath } from "./test-domain-values"
import { assertDenied, runWithSeatbelt, runWithSeatbeltProfile } from "./test-seatbelt"
import { withTestTempDirectory } from "./test-temp-directory"

test("denial assertions reject successful, failed, signalled, and unlaunchable commands without denial evidence", () => {
	const results = [
		spawnSync("/usr/bin/true", [], { encoding: "utf8" }),
		spawnSync("/bin/sh", ["-c", "echo unrelated-failure >&2; exit 7"], { encoding: "utf8" }),
		spawnSync("/bin/sh", ["-c", "kill -TERM $$"], { encoding: "utf8" }),
		spawnSync("/nonexistent/pi-safety-test-command", [], { encoding: "utf8" }),
	]

	for (const result of results) assert.throws(() => assertDenied(result))
})

test("invalid sandbox profiles fail the launch control rather than count as denial", () => {
	const compiled = emitSbpl([])
	assert.throws(
		() => runWithSeatbeltProfile({ ...compiled, source: "(not-a-valid-profile)" }, "/usr/bin/true"),
		/Seatbelt control failed/,
	)
})

test("denial assertions accept an enforced read restriction on an otherwise readable file", () => {
	withTestTempDirectory("seatbelt-denial-", (root) => {
		const file = path.join(root, "readable.txt")
		fs.writeFileSync(file, "readable outside the sandbox")
		const control = spawnSync("/bin/cat", [file], { encoding: "utf8" })
		assert.equal(control.status, 0, control.stderr)
		assert.equal(control.stdout, "readable outside the sandbox")

		const compiled = emitSbpl([
			fileRule({ effect: "deny", operations: ["file-read-data"], matchers: [literal(canonicalPath(file))] }),
		])

		const denied = runWithSeatbelt(compiled, "/bin/cat", [file])
		assertDenied(denied)
		assert.equal(denied.stdout, "")
	})
})

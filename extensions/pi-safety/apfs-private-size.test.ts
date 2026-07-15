import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { readApfsPrivateSize } from "./apfs-private-size"
import { unwrap } from "./result"
import { withTestTempDirectory } from "./test-temp-directory"

test("reports bytes that APFS would immediately reclaim for a file", () => {
	withTestTempDirectory("pi-safety-private-size-", (root) => {
		const source = path.join(root, "source.bin")
		const clone = path.join(root, "clone.bin")
		fs.writeFileSync(source, Buffer.alloc(1024 * 1024, 0x5a))

		assert.ok(unwrap(readApfsPrivateSize(source)) > 0n)
		fs.copyFileSync(source, clone, fs.constants.COPYFILE_FICLONE_FORCE)
		assert.equal(unwrap(readApfsPrivateSize(source)), 0n)
		assert.equal(unwrap(readApfsPrivateSize(clone)), 0n)
	})
})

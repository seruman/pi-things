import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { z } from "zod"
import { readJsonFile } from "./json-file"
import { withTestTempDirectory } from "./test-temp-directory"

test("reads unknown JSON or validates it into the schema output type", () => {
	withTestTempDirectory("json-file-", (root) => {
		const file = path.join(root, "value.json")
		fs.writeFileSync(file, JSON.stringify({ name: "snapshot", count: 3 }))

		const unknownValue = readJsonFile(file)
		assert.equal(unknownValue.ok, true)

		const value = readJsonFile(file, z.object({ name: z.string(), count: z.number().int() }).strict())
		assert.equal(value.ok, true)
		if (value.ok) {
			const name: string = value.value.name
			assert.equal(name, "snapshot")
			assert.equal(value.value.count, 3)
		}
	})
})

test("returns errors for malformed JSON and schema mismatches", () => {
	withTestTempDirectory("json-file-invalid-", (root) => {
		const file = path.join(root, "value.json")
		fs.writeFileSync(file, "{")
		const malformed = readJsonFile(file)
		assert.equal(malformed.ok, false)
		if (!malformed.ok) assert.equal(malformed.error.kind, "json-file")

		fs.writeFileSync(file, JSON.stringify({ name: 3 }))
		const mismatched = readJsonFile(file, z.object({ name: z.string() }))
		assert.equal(mismatched.ok, false)
		if (!mismatched.ok) assert.equal(mismatched.error.kind, "json-file-schema")
	})
})

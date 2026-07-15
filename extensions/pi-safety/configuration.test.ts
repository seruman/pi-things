import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { loadProjectSafetyConfiguration } from "./configuration"
import { withTestTempDirectory } from "./test-temp-directory"

test("loads a strict versioned project safety configuration", () => {
	withTestTempDirectory("pi-safety-config-", (root) => {
		fs.mkdirSync(path.join(root, ".pi"))
		fs.writeFileSync(
			path.join(root, ".pi", "pi-safety.json"),
			JSON.stringify({ version: 1, protectedPaths: ["secrets/**", "config/private.json"] }),
		)
		assert.deepEqual(loadProjectSafetyConfiguration(root), {
			ok: true,
			value: { additionalNoAccessPatterns: ["secrets/**", "config/private.json"] },
		})
	})
})

test("missing configuration is empty while malformed shapes fail closed", () => {
	withTestTempDirectory("pi-safety-config-invalid-", (root) => {
		assert.deepEqual(loadProjectSafetyConfiguration(root), { ok: true, value: { additionalNoAccessPatterns: [] } })
		fs.mkdirSync(path.join(root, ".pi"))
		const configurationPath = path.join(root, ".pi", "pi-safety.json")
		for (const input of [
			{ version: 2, protectedPaths: [] },
			{ version: 1, protectedPaths: [false] },
			{ version: 1, protectedPaths: [], extra: true },
		]) {
			fs.writeFileSync(configurationPath, JSON.stringify(input))
			assert.equal(loadProjectSafetyConfiguration(root).ok, false)
		}
		fs.writeFileSync(configurationPath, "{")
		assert.equal(loadProjectSafetyConfiguration(root).ok, false)
	})
})

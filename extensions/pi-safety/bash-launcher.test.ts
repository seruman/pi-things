import { test } from "bun:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { compileSandboxedBashCommand, createSandboxedBashOperations } from "./bash-launcher"
import { unwrap } from "./result"
import type { CompiledSbpl } from "./sbpl"
import { withTestTempDirectory, withTestTempDirectoryAsync } from "./test-temp-directory"

test("sandbox launcher preserves hostile commands and parameters as inert argv", () => {
	withTestTempDirectory("bash-launcher-", (root) => {
		const injected = path.join(root, "injected")
		const output = path.join(root, "output")
		const hostile = `quote' $(touch ${injected})\nnewline`
		const compiled: CompiledSbpl = {
			source: "(version 1)\n(allow default)",
			parameters: [{ name: "PI_SAFETY_0", value: hostile }],
		}
		const commandValue = "command's\nline"
		const command = `printf %s "command's" > ${JSON.stringify(output)}\nprintf '\\nline' >> ${JSON.stringify(output)}`
		const wrapper = unwrap(compileSandboxedBashCommand(compiled, command))
		const result = spawnSync("/bin/bash", ["-c", wrapper], { encoding: "utf8" })
		assert.equal(result.status, 0, result.stderr)
		assert.equal(fs.readFileSync(output, "utf8"), commandValue)
		assert.equal(fs.existsSync(injected), false)
	})
})

test("generated hostile parameter values remain inert outer-shell argv", () => {
	withTestTempDirectory("bash-launcher-generated-", (root) => {
		for (let index = 0; index < 24; index += 1) {
			const injected = path.join(root, `injected-${index}`)
			const value = `case-${index}-'\"\\\n$(touch ${injected});${String.fromCodePoint(0x3b1 + (index % 20))}`
			const compiled: CompiledSbpl = {
				source: "(version 1)\n(allow default)",
				parameters: [{ name: "PI_SAFETY_0", value }],
			}
			const wrapper = unwrap(compileSandboxedBashCommand(compiled, "/usr/bin/true"))
			const result = spawnSync("/bin/bash", ["-c", wrapper], { encoding: "utf8" })
			assert.equal(result.status, 0, result.stderr)
			assert.equal(fs.existsSync(injected), false)
		}
	})
})

test("sandbox launcher preserves Pi abort propagation", async () => {
	await withTestTempDirectoryAsync("bash-launcher-abort-", async (root) => {
		const compiled: CompiledSbpl = { source: "(version 1)\n(allow default)", parameters: [] }
		const operations = createSandboxedBashOperations(() => compiled)
		const controller = new AbortController()
		const execution = operations.exec("sleep 5", root, {
			onData: () => undefined,
			signal: controller.signal,
		})
		setTimeout(() => controller.abort(), 50)
		await assert.rejects(execution, /aborted/)
	})
})

test("sandbox launcher rejects NUL bytes before invoking an outer shell", () => {
	const compiled: CompiledSbpl = { source: "(version 1)\n(allow default)", parameters: [] }
	assert.deepEqual(compileSandboxedBashCommand(compiled, "printf ok\0touch bad"), {
		ok: false,
		error: { kind: "nul-byte", field: "command" },
	})
})

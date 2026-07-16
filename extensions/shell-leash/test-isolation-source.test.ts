import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const forbidden = [
	["Bun", ".spawn("].join(""),
	["Bun", ".spawnSync("].join(""),
	["from ", '"node:', "child_process", '"'].join(""),
	["from ", "'node:", "child_process", "'"].join(""),
	["pi", ".exec("].join(""),
]

test("shell-leash tests cannot bypass the fixture-only process choke point", async () => {
	const root = fileURLToPath(new URL(".", import.meta.url))
	const files = [...new Bun.Glob("**/*.test.ts").scanSync({ cwd: root, absolute: true })].filter(
		(file) => !file.endsWith("test-isolation-source.test.ts"),
	)
	const violations: string[] = []
	for (const file of files) {
		const source = await readFile(file, "utf8")
		for (const token of forbidden) if (source.includes(token)) violations.push(`${file}: ${token}`)
	}
	expect(violations).toEqual([])
})

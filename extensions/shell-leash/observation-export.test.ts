import { expect, test } from "bun:test"
import { readFile, stat } from "node:fs/promises"
import * as path from "node:path"
import { withTestTempDirectoryAsync } from "../pi-safety/test-temp-directory"
import { writeObservationExport } from "./observation-export"

test("observation export writes a new private JSON file and refuses overwrite", async () => {
	await withTestTempDirectoryAsync("shell-leash-observation-export-", async (root) => {
		const output = path.join(root, "observations.json")
		expect(await writeObservationExport(output, [{ observation: { kind: "dynamic-executable" } }])).toEqual({
			ok: true,
			value: undefined,
		})
		const parsed = JSON.parse(await readFile(output, "utf8")) as { version: number; entries: unknown[] }
		expect(parsed).toMatchObject({ version: 1, entries: [{ observation: { kind: "dynamic-executable" } }] })
		expect((await stat(output)).mode & 0o777).toBe(0o600)
		expect((await writeObservationExport(output, [])).ok).toBe(false)
	})
})

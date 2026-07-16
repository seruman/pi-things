import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import * as path from "node:path"
import { withTestTempDirectoryAsync } from "../pi-safety/test-temp-directory"
import { readRuntimeObservations } from "./runtime-observation"

describe("readRuntimeObservations", () => {
	test("strictly parses newline-delimited hidden shim observations", async () => {
		await withTestTempDirectoryAsync("shell-leash-observations-", async (root) => {
			const log = path.join(root, "events.jsonl")
			const entry = {
				version: 1,
				source: "shim",
				createdAt: "2026-07-14T12:00:00.000Z",
				argv: ["git", "future-command"],
				observation: { kind: "unknown-git", argv: ["git", "future-command"] },
			} as const
			await writeFile(log, `${JSON.stringify(entry)}\n`)

			expect(await readRuntimeObservations(log)).toEqual({ ok: true, value: [entry] })
		})
	})
})

import { describe, expect, test } from "bun:test"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { withTestTempDirectoryAsync } from "../pi-safety/test-temp-directory"
import { prepareShimSession } from "./shim-session"

describe("prepareShimSession", () => {
	test("discovers fixture tools without executing them and prepends private TypeScript shims", async () => {
		await withTestTempDirectoryAsync("shell-leash-session-", async (root) => {
			const fixtureBin = path.join(root, "fixture-bin")
			await mkdir(fixtureBin)
			for (const tool of ["bun", "git", "gh"]) {
				const executable = path.join(fixtureBin, tool)
				await writeFile(executable, "fixture only\n", { mode: 0o600 })
				await chmod(executable, 0o700)
			}

			const prepared = await prepareShimSession({
				privateRoot: root,
				path: fixtureBin,
				shimEntry: "/source/extensions/shell-leash/shim.ts",
			})
			expect(prepared.ok).toBe(true)
			if (!prepared.ok) return
			const session = prepared.value
			expect(session.realExecutables).toEqual({
				git: path.join(fixtureBin, "git"),
				gh: path.join(fixtureBin, "gh"),
			})
			expect(session.path.split(path.delimiter)[0]).toBe(session.shimDirectory)
			const gitLauncher = await readFile(path.join(session.shimDirectory, "git"), "utf8")
			expect(gitLauncher).toContain("/source/extensions/shell-leash/shim.ts")
			expect(gitLauncher).toContain(' git "$@"')
			expect(await session.cleanup()).toEqual({ ok: true, value: undefined })
		})
	})
})

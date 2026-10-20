import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { parentExtensionFlags } from "./parent-flags"

let cwd: string

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "parent-flags-"))
	mkdirSync(join(cwd, "extensions"))
	writeFileSync(join(cwd, "extensions", "guard.ts"), "")
})

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true })
})

test.each(["-ne", "--no-extensions"])(
	"inherits %s and explicit extensions, anchoring local paths to the parent",
	(flag) => {
		expect(
			parentExtensionFlags(
				[flag, "-e", ".", "--extension", "./extensions/guard.ts", "-e", "builtin:codemode", "-e", "."],
				cwd,
			),
		).toEqual([
			"--no-extensions",
			"--extension",
			cwd,
			"--extension",
			join(cwd, "extensions", "guard.ts"),
			"--extension",
			"builtin:codemode",
		])
	},
)

test("does not disable discovery unless the parent did", () => {
	expect(parentExtensionFlags([], cwd)).toEqual([])
	expect(parentExtensionFlags(["-e", "."], cwd)).toEqual(["--extension", cwd])
})

test("keeps builtin and package sources intact and expands home paths", () => {
	const sources = ["builtin:mcp", "npm:pi-example", "git:github.com/example/pi", "https://github.com/example/pi"]
	expect(
		parentExtensionFlags(
			sources.flatMap((source) => ["-e", source]),
			cwd,
		),
	).toEqual(sources.flatMap((source) => ["--extension", source]))
	expect(parentExtensionFlags(["-e", "~"], cwd)).toEqual(["--extension", homedir()])
})

test("uses Pi's argument parser so prompts and other flag values cannot become extension flags", () => {
	expect(
		parentExtensionFlags(
			[
				"--system-prompt",
				"-ne",
				"--session",
				"parent.jsonl",
				"--mode",
				"rpc",
				"--tools",
				"read",
				"--shell-leash-default",
				"deny",
				"parent prompt",
				"--",
				"-ne",
				"-e",
				"./extensions/guard.ts",
			],
			cwd,
		),
	).toEqual([])
})

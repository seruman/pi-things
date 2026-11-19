import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { runHandleSchema, sessionIdSchema } from "../lib/session-delivery/identity"
import { isManagedChildLaunch, parentExtensionFlags } from "./parent-flags"
import type { RunMetadata } from "./runs"

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

test("inherited run environment is not child identity without the exact launched session path", () => {
	const runDir = join(cwd, "run")
	expect(isManagedChildLaunch(runDir, [], cwd)).toBe(false)
	expect(isManagedChildLaunch(runDir, ["--session", "unrelated.jsonl"], cwd)).toBe(false)
	expect(isManagedChildLaunch(runDir, ["--session", "run/session.jsonl"], cwd)).toBe(true)
	expect(isManagedChildLaunch(runDir, ["--", "--session", "run/session.jsonl"], cwd)).toBe(false)
})

function managedRun() {
	const runDir = join(cwd, "run")
	mkdirSync(runDir)
	const initial = join(runDir, "session.jsonl")
	const current = join(cwd, "new-session.jsonl")

	const metadata: RunMetadata = {
		version: 1,
		handle: runHandleSchema.parse("abcdef"),
		blockId: "block:test",
		parentSessionId: sessionIdSchema.parse("parent"),
		sessionFile: current,
		cwd,
		provider: "test",
		model: "test",
		thinking: "off",
		launchArgs: [],
		createdAt: new Date().toISOString(),
	}

	const publish = (value: RunMetadata) => writeFileSync(join(runDir, "metadata.json"), JSON.stringify(value))

	return { runDir, initial, current, metadata, publish }
}

test("launch identity survives current transcript changes without trusting current or historical paths", () => {
	const { runDir, initial, current, metadata, publish } = managedRun()
	const historical = join(cwd, "historical.jsonl")
	publish({ ...metadata, launchSessionFile: initial, sessionFiles: [initial, historical, current] })
	expect(isManagedChildLaunch(runDir, ["--session", initial], cwd)).toBe(true)
	expect(isManagedChildLaunch(runDir, ["--session", "run/session.jsonl"], cwd)).toBe(true)
	expect(isManagedChildLaunch(runDir, ["--session", current], cwd)).toBe(false)
	expect(isManagedChildLaunch(runDir, ["--session", historical], cwd)).toBe(false)
	expect(isManagedChildLaunch(runDir, ["--session", "session.jsonl"], cwd)).toBe(false)
	expect(isManagedChildLaunch(runDir, [], cwd)).toBe(false)

	publish({ ...metadata, launchSessionFile: current, sessionFiles: [initial, historical, current] })
	expect(isManagedChildLaunch(runDir, ["--session", current], cwd)).toBe(true)
	expect(isManagedChildLaunch(runDir, ["--session", initial], cwd)).toBe(false)
})

test("legacy metadata accepts only current or deterministic initial path, not accounting history", () => {
	const { runDir, initial, current, metadata, publish } = managedRun()
	const historical = join(cwd, "historical.jsonl")
	publish({ ...metadata, sessionFiles: [historical] })
	expect(isManagedChildLaunch(runDir, ["--session", initial], cwd)).toBe(true)
	expect(isManagedChildLaunch(runDir, ["--session", current], cwd)).toBe(true)
	expect(isManagedChildLaunch(runDir, ["--session", historical], cwd)).toBe(false)
})

test.each(["{", "{}", '{"launchSessionFile":42}'])(
	"malformed metadata does not use the late-startup fallback: %s",
	(contents) => {
		const { runDir, initial } = managedRun()
		writeFileSync(join(runDir, "metadata.json"), contents)
		expect(isManagedChildLaunch(runDir, ["--session", initial], cwd)).toBe(false)
	},
)

test.each([{ poolFlag: ["--session-pool", "review"] }, { poolFlag: ["--session-pool=review"] }])(
	"does not forward the parent's pool flag %j",
	({ poolFlag }) => {
		expect(parentExtensionFlags(["--no-extensions", ...poolFlag, "-e", "./extensions/guard.ts"], cwd)).toEqual([
			"--no-extensions",
			"--extension",
			join(cwd, "extensions", "guard.ts"),
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

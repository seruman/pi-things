import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildPiStartupInput, parseSplitForkArgs, resolvePiInvocation } from "./split-fork.ts"
import {
	buildHandoffRequest,
	buildReceivingDraft,
	consumeHandoffManifestFile,
	createHandoffManifestFile,
	formatGitSnapshot,
} from "./split-handoff.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createRawManifest(raw: string): Promise<{ directory: string; manifestFile: string }> {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-split-handoff-"))
	temporaryDirectories.push(directory)
	const manifestFile = path.join(directory, "manifest.json")
	await writeFile(manifestFile, raw, { mode: 0o600 })
	return { directory, manifestFile }
}

describe("handoff request", () => {
	test("keeps the goal, conversation, and repository evidence in distinct sections", () => {
		const request = buildHandoffRequest("User: investigate auth", "implement the verified fix", {
			branch: "feature/auth",
			head: "abc123",
			status: " M src/auth.ts",
			diffStat: "src/auth.ts | 2 +-",
			stagedDiffStat: "src/config.ts | 1 +",
		})

		expect(request).toContain("<conversation_history>\nUser: investigate auth\n</conversation_history>")
		expect(request).toContain("Branch: feature/auth")
		expect(request).toContain("HEAD: abc123")
		expect(request).toContain("Unstaged diff stat:\nsrc/auth.ts | 2 +-")
		expect(request).toContain("Staged diff stat:\nsrc/config.ts | 1 +")
		expect(request).toContain("<next_goal>\nimplement the verified fix\n</next_goal>")
	})

	test("describes an empty status without inventing repository facts", () => {
		expect(formatGitSnapshot({})).toBe("Working tree: clean or unavailable")
	})
})

describe("receiving draft", () => {
	test("adds a concise read-only orientation gate after the generated handoff", () => {
		const draft = buildReceivingDraft("## Goal\nContinue the investigation.\n")

		expect(draft).toStartWith("## Goal\nContinue the investigation.")
		expect(draft).toContain("## On Receipt")
		expect(draft).toContain("at most five concise bullets")
		expect(draft).toContain("Do not modify anything")
		expect(draft).toContain("wait for explicit user authorization")
	})
})

describe("command arguments", () => {
	test("parses a split direction and rejects an invalid one", () => {
		expect(parseSplitForkArgs("-d down continue the investigation")).toEqual({
			direction: "down",
			prompt: "continue the investigation",
		})
		expect(() => parseSplitForkArgs("-d sideways continue")).toThrow("Invalid direction")
	})
})

describe("Pi child startup", () => {
	test("does not pass Bun's virtual script path to a standalone Pi executable", () => {
		expect(resolvePiInvocation("/nix/store/example/bin/pi", "/$bunfs/root/pi", true)).toEqual([
			"/nix/store/example/bin/pi",
		])
	})

	test("keeps handoff text out of argv", async () => {
		const handoff = "Sensitive-looking shell text: $(touch /tmp/should-not-run) `whoami`"
		const manifestFile = await createHandoffManifestFile({
			goal: "continue safely",
			handoff,
			parentSession: "/tmp/source.jsonl",
		})
		const directory = path.dirname(manifestFile)
		temporaryDirectories.push(directory)

		expect((await stat(manifestFile)).mode & 0o777).toBe(0o600)
		const startupInput = buildPiStartupInput(undefined, `/split-handoff --receive ${manifestFile}`)
		expect(startupInput).toContain(manifestFile)
		expect(startupInput).not.toContain("'-e'")
		expect(startupInput).not.toContain(handoff)
		expect(startupInput).not.toContain("/$bunfs/root/pi")
		expect(startupInput).not.toContain(" '--' ")

		const manifest = await consumeHandoffManifestFile(manifestFile)
		expect(manifest.handoff).toBe(handoff)
		expect((await stat(manifestFile)).isFile()).toBe(true)
	})

	test("accepts a manifest beneath a wrapped temp directory", async () => {
		const wrapper = await mkdtemp(path.join(tmpdir(), "nix-shell."))
		temporaryDirectories.push(wrapper)
		const directory = await mkdtemp(path.join(wrapper, "pi-split-handoff-"))
		const manifestFile = path.join(directory, "manifest.json")
		await writeFile(
			manifestFile,
			JSON.stringify({ version: 1, goal: "continue", handoff: "handoff", parentSession: "/tmp/source.jsonl" }),
			{ mode: 0o600 },
		)

		expect(await consumeHandoffManifestFile(manifestFile)).toEqual({
			version: 1,
			goal: "continue",
			handoff: "handoff",
			parentSession: "/tmp/source.jsonl",
		})
		expect((await stat(manifestFile)).isFile()).toBe(true)
	})

	test("rejects an invalid manifest and leaves it for cleanup", async () => {
		const { manifestFile } = await createRawManifest("null")

		await expect(consumeHandoffManifestFile(manifestFile)).rejects.toThrow("Invalid split-handoff manifest")
		expect((await stat(manifestFile)).isFile()).toBe(true)
	})

	test("rejects an oversized manifest and leaves it for cleanup", async () => {
		const { manifestFile } = await createRawManifest("x".repeat(1024 * 1024 + 1))

		await expect(consumeHandoffManifestFile(manifestFile)).rejects.toThrow("Split-handoff manifest is too large")
		expect((await stat(manifestFile)).isFile()).toBe(true)
	})
})

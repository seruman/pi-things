import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { testDirectory } from "./fixtures/sdk"

test.each([
	["default", ["--no-builtin-tools"], ["session_list", "session_send"]],
	["no tools", ["--no-tools"], []],
	["readonly selection", ["--tools", "read,grep,find,ls"], []],
	["explicit list selection", ["--tools", "session_list"], ["session_list"]],
	["exclude send", ["--exclude-tools", "session_send"], ["session_list"]],
] as const)(
	"installed Pi honors %s with an explicitly loaded messaging extension",
	async (_name, flags, expected) => {
		const root = testDirectory()
		const report = join(root, "tools.json")
		const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: root, SESSION_MESSAGES_TEST_REPORT: report }
		delete env.PI_SUBAGENT_RUN_DIR

		const child = Bun.spawn(
			[
				process.env.PI_TEST_EXECUTABLE ?? "pi",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				...flags,
				"--session-pool",
				"test",
				"-e",
				join(import.meta.dir, "fixtures/runtime-proof.ts"),
				"--provider",
				"session-message-test",
				"--model",
				"controlled",
				"--session",
				join(root, "session.jsonl"),
				"--mode",
				"json",
				"-p",
				"/sm-tool-proof",
			],
			{ cwd: root, env, stdout: "pipe", stderr: "pipe" },
		)

		const timeout = setTimeout(() => child.kill(), 10000)

		try {
			await new Response(child.stdout).text()
			const error = await new Response(child.stderr).text()
			expect({ code: await child.exited, error }).toEqual({ code: 0, error: "" })
			expect(JSON.parse(readFileSync(report, "utf8"))).toEqual(expected)
		} finally {
			clearTimeout(timeout)
			child.kill()
		}
	},
	15000,
)

test("installed Pi runtime proves idle, steer, follow-up and passive delivery with a controlled provider", async () => {
	const root = testDirectory()
	const report = join(root, "proof.json")
	const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: root, SESSION_MESSAGES_TEST_REPORT: report }
	delete env.PI_SUBAGENT_RUN_DIR

	const child = Bun.spawn(
		[
			process.env.PI_TEST_EXECUTABLE ?? "pi",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-builtin-tools",
			"-e",
			join(import.meta.dir, "fixtures/runtime-proof.ts"),
			"--provider",
			"session-message-test",
			"--model",
			"controlled",
			"--session",
			join(root, "session.jsonl"),
			"--mode",
			"json",
			"-p",
			"/sm-delivery-proof",
		],
		{ cwd: root, env, stdout: "pipe", stderr: "pipe" },
	)

	const timeout = setTimeout(() => child.kill(), 15000)

	try {
		const output = await new Response(child.stdout).text()
		const error = await new Response(child.stderr).text()
		expect({ code: await child.exited, error }).toEqual({ code: 0, error: "" })
		expect(output).not.toContain("extension_error")
		expect(JSON.parse(readFileSync(report, "utf8"))).toEqual({
			results: ["steer", "followUp", "passive", "completion-steer", "idle-passive", "idle-wake"],
			requests: 11,
		})
	} finally {
		clearTimeout(timeout)
		child.kill()
	}
}, 20000)

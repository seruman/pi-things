import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { testDirectory } from "../session-messages/fixtures/sdk"

test.each([
	["default", ["--no-builtin-tools"], true],
	["all disabled", ["--no-tools"], false],
	["readonly", ["--tools", "read,grep,find,ls"], false],
	["explicit reply", ["--tools", "agent_reply"], true],
	["excluded reply", ["--exclude-tools", "agent_reply"], false],
] as const)(
	"installed Pi private-only family delivery preserves %s restrictions",
	async (_name, flags, reply) => {
		const root = testDirectory()
		const handle = "c0ffee"
		const runDir = join(root, "subagents", "by-parent", "parent", handle)
		mkdirSync(runDir, { recursive: true })
		const sessionFile = join(runDir, "session.jsonl")
		writeFileSync(sessionFile, "")
		writeFileSync(
			join(runDir, "metadata.json"),
			JSON.stringify({
				version: 1,
				handle,
				relation: randomUUID(),
				blockId: "fixture",
				parentSessionId: "parent",
				sessionFile,
				launchSessionFile: sessionFile,
				cwd: root,
				provider: "session-message-test",
				model: "controlled",
				thinking: "off",
				launchArgs: [],
				createdAt: new Date().toISOString(),
			}),
		)
		const report = join(root, "private.json")

		const child = Bun.spawn(
			[
				process.env.PI_TEST_EXECUTABLE ?? "pi",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				...flags,
				"-e",
				join(import.meta.dir, "fixtures/private-runtime.ts"),
				"--provider",
				"session-message-test",
				"--model",
				"controlled",
				"--session",
				sessionFile,
				"--mode",
				"json",
				"-p",
				"/private-proof",
			],
			{
				cwd: root,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: root,
					PI_SUBAGENT_RUN_DIR: runDir,
					PRIVATE_RUNTIME_HANDLE: handle,
					PRIVATE_RUNTIME_REPORT: report,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		)

		const timeout = setTimeout(() => child.kill(), 10000)

		try {
			const output = await new Response(child.stdout).text()
			const error = await new Response(child.stderr).text()
			expect({ code: await child.exited, error }).toEqual({ code: 0, error: "" })
			expect(output).not.toContain("extension_error")
			expect(JSON.parse(readFileSync(report, "utf8"))).toEqual({ reply, public: false, private: true, completion: 1 })
		} finally {
			clearTimeout(timeout)
			child.kill()
		}
	},
	15000,
)

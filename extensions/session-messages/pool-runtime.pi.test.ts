import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { testDirectory } from "./fixtures/sdk"

const recordSchema = z.object({
	reason: z.string(),
	pool: z.string().nullable(),
	generation: z.string().nullable(),
	instance: z.string(),
	flag: z.union([z.string(), z.boolean()]).nullable(),
})

async function launch(flags: readonly string[], command = "/sm-pool-report") {
	const root = testDirectory()
	const report = join(root, "report.jsonl")
	const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: root, SESSION_MESSAGES_TEST_REPORT: report }
	delete env.PI_SUBAGENT_RUN_DIR

	const child = Bun.spawn(
		[
			process.env.PI_TEST_EXECUTABLE ?? "pi",
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-builtin-tools",
			"-e",
			join(import.meta.dir, "fixtures/pool-flag-proof.ts"),
			...flags,
			"--provider",
			"session-message-test",
			"--model",
			"controlled",
			"--session",
			join(root, "session.jsonl"),
			"--mode",
			"json",
			"-p",
			command,
		],
		{ cwd: root, env, stdout: "pipe", stderr: "pipe" },
	)

	const timeout = setTimeout(() => child.kill(), 10000)

	try {
		const [output, error, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		])

		return {
			output,
			error,
			code,
			records: existsSync(report)
				? readFileSync(report, "utf8")
						.trim()
						.split("\n")
						.map((line) => recordSchema.parse(JSON.parse(line)))
				: [],
		}
	} finally {
		clearTimeout(timeout)
		child.kill()
	}
}

test.each([
	{ flags: [], pool: null },
	{ flags: ["--session-pool", "review"], pool: "review" },
	{ flags: ["--session-pool=Review_1.2-3"], pool: "Review_1.2-3" },
	{ flags: ["--session-pool", "x".repeat(64)], pool: "x".repeat(64) },
])(
	"installed CLI accepts pool flags %j",
	async ({ flags, pool }) => {
		const result = await launch(flags)
		expect({ code: result.code, error: result.error }).toEqual({ code: 0, error: "" })
		expect(result.output).not.toContain("extension_error")
		expect(result.records).toHaveLength(1)
		expect(result.records[0]).toMatchObject({ reason: "startup", pool, flag: pool })
	},
	15000,
)

test.each(["", " bad", "bad ", "bad/name", "x".repeat(65)])(
	"installed CLI reports invalid pool %j nonfatally and stays private",
	async (pool) => {
		const result = await launch([`--session-pool=${pool}`])
		expect(result.code).toBe(0)
		expect(result.output + result.error).toContain("Invalid --session-pool")
		expect(result.records).toHaveLength(1)
		expect(result.records[0]).toMatchObject({ reason: "startup", pool: null, generation: null, flag: pool })
	},
	15000,
)

test("installed CLI rejects a missing string flag value before starting a session", async () => {
	const result = await launch(["--session-pool"])
	expect(result.code).toBe(1)
	expect(result.output + result.error).toContain('Extension flag "--session-pool" requires a value')
	expect(result.records).toEqual([])
}, 15000)

test.each([[], ["--session-pool", "review"], ["--session-pool=review"]])(
	"installed CLI reload reapplies explicit pool configuration %j with a fresh generation",
	async (...flags) => {
		const result = await launch(flags, "/sm-pool-reload")
		expect({ code: result.code, error: result.error }).toEqual({ code: 0, error: "" })
		expect(result.output).not.toContain("extension_error")
		const pool = flags.length ? "review" : null
		expect(result.records.map(({ reason, pool }) => ({ reason, pool }))).toEqual([
			{ reason: "startup", pool },
			{ reason: "leave", pool: null },
			{ reason: "reload", pool },
		])
		expect(result.records[2]?.instance).not.toBe(result.records[0]?.instance)

		if (pool) expect(result.records[2]?.generation).not.toBe(result.records[0]?.generation)
	},
	15000,
)

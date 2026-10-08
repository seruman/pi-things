import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { classifyTier } from "./classifier"
import { configSchema } from "./config"
import { DECISION_ENTRY } from "./router"

// Opt-in: real local classifier + installed Pi CLI, fake downstream models, isolated configuration.
// The caller owns the Ollama process. This script neither downloads nor starts it.
const root = mkdtempSync(join(tmpdir(), "model-router-smoke-"))
const agentDir = join(root, "agent")
const cwd = join(root, "workspace")
mkdirSync(agentDir)
mkdirSync(cwd)
const config = configSchema.parse({
	routers: {
		smoke: {
			tiers: {
				trivial: { provider: "router-smoke", model: "small", thinking: "low" },
				standard: { provider: "router-smoke", model: "middle", thinking: "medium" },
				strong: { provider: "router-smoke", model: "big", thinking: "high" },
			},
		},
	},
	classifier: {
		baseUrl: process.env.ROUTER_SMOKE_BASE_URL ?? "http://127.0.0.1:11434/v1",
		model: process.env.ROUTER_SMOKE_MODEL ?? "clef-flash:9b-mxfp8",
	},
})
writeFileSync(join(agentDir, "model-router.json"), JSON.stringify(config, null, 2))
writeFileSync(
	join(agentDir, "settings.json"),
	JSON.stringify({ cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false } }),
)
const prewarm = await classifyTier(
	{ ...config.classifier, timeoutMs: 30_000 },
	{ prompt: "Prewarm the local classifier", hasImages: false },
)
assert.equal(prewarm.kind, "classified", `Local classifier unavailable: ${JSON.stringify(prewarm)}`)
const directory = fileURLToPath(new URL(".", import.meta.url))
const session = join(root, "session.jsonl")
const prompts = [
	"What command prints the current working directory?",
	"Design a distributed payment ledger that preserves correctness across retries, out-of-order events, and partial failures. Explain consistency tradeoffs.",
	"Yes, go ahead with that design.",
]
for (const [index, prompt] of prompts.entries()) {
	const child = Bun.spawn(
		[
			process.env.ROUTER_SMOKE_PI ?? "pi",
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-tools",
			"--no-approve",
			"--mode",
			"json",
			"--print",
			"--session",
			session,
			"-e",
			resolve(directory, "fixtures/smoke-provider.ts"),
			"-e",
			resolve(directory, "index.ts"),
			...(index === 0 ? ["--model", "model-router/smoke"] : []),
			prompt,
		],
		{
			cwd,
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: root,
				PI_CODING_AGENT_DIR: agentDir,
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	)
	const timeout = setTimeout(() => child.kill(), 30_000)
	try {
		const [stdout, stderr, status] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		])
		writeFileSync(join(root, `run-${index}.jsonl`), stdout)
		writeFileSync(join(root, `run-${index}.stderr`), stderr)
		assert.equal(status, 0, `Pi failed: ${stderr}\n${stdout}`)
		const entries = readFileSync(session, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
		const decisions = entries.filter((entry) => entry.type === "custom" && entry.customType === DECISION_ENTRY)
		assert.equal(decisions.length, index + 1)
		const decision = decisions.at(-1).data
		assert.equal(decision.action, "classified", JSON.stringify(decision))
		const answer = entries
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant")
			.at(-1).message
		assert.equal(answer.stopReason, "stop")
		const tiers = config.routers.smoke.tiers
		const target = tiers[decision.tier as keyof typeof tiers]
		assert.equal(answer.provider, target.provider)
		assert.equal(answer.model, target.model)
		assert.equal(answer.thinkingLevel, target.thinking)
		console.log(
			JSON.stringify({
				prompt,
				tier: decision.tier,
				model: answer.model,
				thinking: answer.thinkingLevel,
				classifier: decision.classifier,
			}),
		)
	} finally {
		clearTimeout(timeout)
	}
}
console.log(`Smoke passed. Isolated session and logs: ${root}`)

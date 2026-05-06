import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import type { AgentToolResult } from "@mariozechner/pi-agent-core"
import { StringEnum } from "@mariozechner/pi-ai"
import { type ExtensionAPI, getMarkdownTheme } from "@mariozechner/pi-coding-agent"
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui"
import { Type } from "typebox"
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js"

const MAX_PARALLEL_TASKS = 8
const MAX_CONCURRENCY = 4
const MAX_SUMMARY_CHARS = 3000
const MAX_EVENT_LINES = 16

const SUBMIT_RESULT_TOOL = "submit_result"
const SUBMIT_RESULT_ENFORCEMENT = [
	"Closure contract for this delegated task:",
	`- You MUST call ${SUBMIT_RESULT_TOOL} exactly once when finished.`,
	"- Use status='success' with data for completed work.",
	"- Use status='aborted' with error only if truly blocked.",
	"- Do not finish with plain text-only completion.",
].join("\n")

const COST_GUARDRAILS = [
	"Efficiency policy:",
	"- Minimize turns and tool calls; avoid exploration beyond task scope.",
	"- Reuse already-read context; do not reread the same files without reason.",
	"- Keep outputs concise and structured for submit_result.",
	"- Stop immediately after submit_result; no extra narration.",
].join("\n")

type SubmitResultPayload = {
	status: "success" | "aborted"
	data?: unknown
	error?: string
}

type Usage = {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
	cost: number
	turns: number
	contextTokens: number
}

type TaskResult = {
	agent: string
	agentSource: AgentConfig["source"] | "unknown"
	task: string
	exitCode: number
	stopReason?: string
	errorMessage?: string
	stderr: string
	final: string
	outputPath?: string
	events: string[]
	usage: Usage
	model?: string
	step?: number
}

type Details = {
	mode: "single" | "parallel"
	agentScope: AgentScope
	projectAgentsDir: string | null
	results: TaskResult[]
}

type Update = (partial: AgentToolResult<Details>) => void

type RunStatus = "queued" | "running" | "done" | "failed" | "aborted"

type RunInfo = {
	id: number
	agent: string
	task: string
	cwd: string
	args: string[]
	pid?: number
	status: RunStatus
	startedAt: number
	endedAt?: number
	exitCode?: number
	error?: string
}

const runs = new Map<number, RunInfo>()
const runOrder: number[] = []
let nextRunId = 1

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function createRun(input: { agent: string; task: string; cwd: string; args: string[] }) {
	const run: RunInfo = {
		id: nextRunId++,
		agent: input.agent,
		task: input.task,
		cwd: input.cwd,
		args: [...input.args],
		status: "queued",
		startedAt: Date.now(),
	}
	runs.set(run.id, run)
	runOrder.push(run.id)
	if (runOrder.length > 200) {
		const id = runOrder.shift()
		if (id) runs.delete(id)
	}
	return run.id
}

function updateRun(id: number, patch: Partial<RunInfo>) {
	const run = runs.get(id)
	if (!run) return
	Object.assign(run, patch)
}

function elapsed(run: RunInfo) {
	const end = run.endedAt ?? Date.now()
	const ms = Math.max(0, end - run.startedAt)
	const sec = Math.floor(ms / 1000)
	const min = Math.floor(sec / 60)
	if (min > 0) return `${min}m${String(sec % 60).padStart(2, "0")}s`
	return `${sec}s`
}

function sessionKey(ctx: { cwd: string; sessionManager: { getSessionFile(): string | undefined } }) {
	return ctx.sessionManager.getSessionFile() ?? `ephemeral:${ctx.cwd}`
}

const guidance = [
	"Subagent usage policy:",
	"- Use the subagent tool only for large repo-wide exploration, expensive independent work units, or when the user explicitly asks for parallel subagents.",
	"- Do not use subagents for small local checks, obvious file reads, or inspecting the current extension's own configuration.",
	"- For independent units, prefer one parallel call with tasks[].",
	"- When the user asks for N parallel subagents, make exactly one subagent tool call with tasks.length = N.",
	"- Do not poll for subagent status; this tool already waits and streams progress.",
	"- Ask subagents for concise, structured results.",
].join("\n")

function trim(text: string, max = MAX_SUMMARY_CHARS) {
	if (text.length <= max) return text
	return `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars]`
}

function truncateWithArtifact(text: string, cwd: string, agent: string) {
	if (text.length <= MAX_SUMMARY_CHARS) return { content: text }
	const removed = text.length - MAX_SUMMARY_CHARS
	const head = text.slice(0, MAX_SUMMARY_CHARS)
	try {
		const dir = path.join(cwd, ".pi", "subagent-output")
		fs.mkdirSync(dir, { recursive: true })
		const safe = agent.replace(/[^\w.-]+/g, "_")
		const file = `${Date.now()}-${process.pid}-${safe}.md`
		const filePath = path.join(dir, file)
		fs.writeFileSync(filePath, text, "utf-8")
		const shown = path.relative(cwd, filePath) || filePath
		return {
			content: `${head}\n\n...${removed} chars truncated...\n\nFull output saved to: ${shown}\nUse read with offset/limit to inspect specific sections.`,
			outputPath: filePath,
		}
	} catch {
		return { content: `${head}\n\n[truncated ${removed} chars]` }
	}
}

function summarizeToolCall(name: string, args: Record<string, unknown>) {
	if (name === "bash") return `$ ${String(args.command ?? "")}`
	if (name === "read") return `read ${String(args.path ?? args.file_path ?? "")}`
	if (name === "write") return `write ${String(args.path ?? args.file_path ?? "")}`
	if (name === "edit") return `edit ${String(args.path ?? args.file_path ?? "")}`
	if (name === "grep") return `grep /${String(args.pattern ?? "")}/`
	if (name === "find") return `find ${String(args.pattern ?? "*")}`
	if (name === "ls") return `ls ${String(args.path ?? ".")}`
	return `${name} ${JSON.stringify(args).slice(0, 120)}`
}

function formatUsage(usage: Usage) {
	const parts: string[] = []
	if (usage.turns) parts.push(`${usage.turns}t`)
	if (usage.input) parts.push(`↑${usage.input}`)
	if (usage.output) parts.push(`↓${usage.output}`)
	if (usage.cacheRead) parts.push(`R${usage.cacheRead}`)
	if (usage.cacheWrite) parts.push(`W${usage.cacheWrite}`)
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`)
	if (usage.contextTokens) parts.push(`ctx:${usage.contextTokens}`)
	return parts.join(" ")
}

function totalUsage(results: TaskResult[]) {
	return results.reduce<Usage>(
		(acc, item) => ({
			input: acc.input + item.usage.input,
			output: acc.output + item.usage.output,
			cacheRead: acc.cacheRead + item.usage.cacheRead,
			cacheWrite: acc.cacheWrite + item.usage.cacheWrite,
			cost: acc.cost + item.usage.cost,
			turns: acc.turns + item.usage.turns,
			contextTokens: acc.contextTokens + item.usage.contextTokens,
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 },
	)
}

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

function marker(item: TaskResult, tick = Date.now()) {
	if (item.exitCode === -1) return SPIN[Math.floor(tick / 100) % SPIN.length]
	if (item.exitCode === 0) return "✓"
	return "✗"
}

function countToolEvents(item: TaskResult) {
	return item.events.filter((line) => line.startsWith("→ ")).length
}

function progress(mode: Details["mode"], results: TaskResult[]) {
	if (results.length === 0) return `${mode}: no tasks`
	const done = results.filter((item) => item.exitCode !== -1).length
	const running = results.length - done
	const failed = results.filter((item) => item.exitCode > 0).length
	const usage = formatUsage(totalUsage(results))
	const usageText = usage ? ` · ${running > 0 ? `live ${usage}` : usage}` : ""
	const head = `${mode} ${results.length} agents  ${done} done · ${running} running · ${failed} failed${usageText}`
	const tick = Date.now()
	const rows = results.map((item, index) => {
		const isLast = index === results.length - 1
		const branch = isLast ? "└" : "├"
		const label = item.step ? `${item.agent}(${item.step})` : item.agent
		const line = item.events.at(-1) || item.final || item.task
		const tools = countToolEvents(item)
		const usage = formatUsage(item.usage)
		const meta = [tools > 0 ? `${tools} tools` : "", usage].filter(Boolean).join(" · ")
		const metaText = meta ? ` · ${meta}` : ""
		return `${branch} ${marker(item, tick)} ${label}: ${trim(line, 100)}${metaText}`
	})
	return `${head}\n${rows.join("\n")}`
}

function promptFile(agentName: string, prompt: string) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-"))
	const safe = agentName.replace(/[^\w.-]+/g, "_")
	const filePath = path.join(dir, `${safe}.md`)
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 })
	return { dir, filePath }
}

function extensionSiblingPath(...parts: string[]) {
	const file = fileURLToPath(import.meta.url)
	return path.join(path.dirname(file), ...parts)
}

function parseSubmitResultPayload(input: Record<string, unknown>): SubmitResultPayload | null {
	const status = input.status === "aborted" ? "aborted" : input.status === "success" ? "success" : null
	if (!status) return null
	return {
		status,
		...(input.data !== undefined ? { data: input.data } : {}),
		...(typeof input.error === "string" && input.error ? { error: input.error } : {}),
	}
}

function formatSubmitResult(payload: SubmitResultPayload) {
	if (payload.status === "aborted") return payload.error || "Subagent aborted without error details."
	if (payload.data === undefined || payload.data === null) return "Submitted success with no data."
	if (typeof payload.data === "string") return payload.data
	try {
		return JSON.stringify(payload.data, null, 2)
	} catch {
		return String(payload.data)
	}
}

function parseCommandLine(value: string): string[] {
	const parts: string[] = []
	let current = ""
	let quote: "'" | '"' | undefined
	let escaped = false

	for (const char of value) {
		if (escaped) {
			current += char
			escaped = false
			continue
		}
		if (char === "\\" && quote !== "'") {
			escaped = true
			continue
		}
		if ((char === "'" || char === '"') && (!quote || quote === char)) {
			quote = quote ? undefined : char
			continue
		}
		if (/\s/.test(char) && !quote) {
			if (current) {
				parts.push(current)
				current = ""
			}
			continue
		}
		current += char
	}

	if (escaped) current += "\\"
	if (current) parts.push(current)
	return parts
}

function getPiInvocationParts(): [string, ...string[]] {
	const override = process.env.PI_SUBAGENT_COMMAND?.trim()
	if (override) {
		const [command, ...args] = parseCommandLine(override)
		if (command) return [command, ...args]
	}

	const legacyBinOverride = process.env.PI_SUBAGENT_BIN?.trim()
	if (legacyBinOverride) return [legacyBinOverride]

	const currentScript = process.argv[1]
	if (currentScript && fs.existsSync(currentScript)) {
		return [process.execPath, currentScript]
	}

	const execName = path.basename(process.execPath).toLowerCase()
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
	if (!isGenericRuntime) {
		return [process.execPath]
	}

	return ["pi"]
}

function parseFinalText(message: unknown) {
	if (!isRecord(message)) return ""
	if (asString(message.role) !== "assistant") return ""
	const content = message.content
	if (!Array.isArray(content)) return ""
	for (const part of content) {
		if (!isRecord(part)) continue
		if (asString(part.type) !== "text") continue
		const text = asString(part.text)
		if (text) return text
	}
	return ""
}

function extractToolText(toolResult: unknown) {
	if (!isRecord(toolResult) || !Array.isArray(toolResult.content)) return ""
	for (const part of toolResult.content) {
		if (!isRecord(part)) continue
		if (asString(part.type) !== "text") continue
		const text = asString(part.text)
		if (text) return text
	}
	return ""
}

function pushEvent(result: TaskResult, line: string) {
	result.events.push(line)
	if (result.events.length > MAX_EVENT_LINES) result.events = result.events.slice(-MAX_EVENT_LINES)
}

async function runTask(
	baseCwd: string,
	agents: AgentConfig[],
	input: { agent: string; task: string; cwd?: string; step?: number },
	signal: AbortSignal | undefined,
	onUpdate: Update | undefined,
	buildDetails: (results: TaskResult[]) => Details,
): Promise<TaskResult> {
	const agent = agents.find((item) => item.name === input.agent)
	if (!agent) {
		return {
			agent: input.agent,
			agentSource: "unknown",
			task: input.task,
			exitCode: 1,
			stderr: `Unknown agent: ${input.agent}`,
			final: "",
			events: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 },
			step: input.step,
		}
	}

	const result: TaskResult = {
		agent: input.agent,
		agentSource: agent.source,
		task: input.task,
		exitCode: -1,
		stderr: "",
		final: "",
		events: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 },
		step: input.step,
	}

	let tmpDir: string | undefined
	let tmpPrompt: string | undefined
	let aborted = false
	let submitResult: SubmitResultPayload | null = null
	let spinnerTimer: ReturnType<typeof setInterval> | undefined

	const emit = () => {
		const details = buildDetails([result])
		onUpdate?.({
			content: [{ type: "text", text: progress(details.mode, details.results) }],
			details,
		})
	}

	try {
		const piInvocation = getPiInvocationParts()
		const [piCommand, ...piCommandArgs] = piInvocation
		const childExtension = extensionSiblingPath("internal", "submit-result-extension.ts")
		const secretGuardExtension = extensionSiblingPath("..", "secret-guard", "index.ts")
		const args: string[] = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"-e",
			childExtension,
			"-e",
			secretGuardExtension,
		]

		const toolList = agent.tools
		if (toolList && toolList.length > 0) args.push("--tools", toolList.join(","))
		const enforcedPrompt = [agent.systemPrompt.trim(), COST_GUARDRAILS, SUBMIT_RESULT_ENFORCEMENT]
			.filter(Boolean)
			.join("\n\n")
		if (enforcedPrompt) {
			const tmp = promptFile(agent.name, enforcedPrompt)
			tmpDir = tmp.dir
			tmpPrompt = tmp.filePath
			args.push("--append-system-prompt", tmpPrompt)
		}
		args.push(`Task: ${input.task}`)

		const cwd = input.cwd ?? baseCwd
		const spawnArgs = [...piCommandArgs, ...args]
		const runId = createRun({ agent: input.agent, task: input.task, cwd, args: [piCommand, ...spawnArgs] })

		result.exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(piCommand, spawnArgs, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK || "1",
				},
			})

			updateRun(runId, { status: "running", pid: proc.pid })
			if (onUpdate) {
				spinnerTimer = setInterval(() => {
					if (result.exitCode === -1 && !aborted) emit()
				}, 120)
			}

			let buffer = ""
			const processLine = (line: string) => {
				if (!line.trim()) return
				let event: unknown
				try {
					event = JSON.parse(line)
				} catch {
					return
				}
				if (!isRecord(event)) return
				const data = event

				if (data.type === "message_end" && isRecord(data.message)) {
					const message = data.message
					const text = parseFinalText(message)
					if (text && !submitResult) {
						const out = truncateWithArtifact(text, cwd, input.agent)
						result.final = out.content
						result.outputPath = out.outputPath
						pushEvent(result, text.split("\n")[0])
					}
					if (asString(message.role) === "assistant") {
						result.stopReason = asString(message.stopReason)
						result.errorMessage = asString(message.errorMessage)
						result.usage.turns += 1
						if (isRecord(message.usage)) {
							const usage = message.usage
							result.usage.input += asNumber(usage.input) ?? 0
							result.usage.output += asNumber(usage.output) ?? 0
							result.usage.cacheRead += asNumber(usage.cacheRead) ?? 0
							result.usage.cacheWrite += asNumber(usage.cacheWrite) ?? 0
							if (isRecord(usage.cost)) {
								result.usage.cost += asNumber(usage.cost.total) ?? 0
							}
							result.usage.contextTokens = asNumber(usage.totalTokens) ?? 0
						}
						if (!result.model) {
							const model = asString(message.model)
							if (model) result.model = model
						}
						emit()
					}
				}

				const captureSubmitResult = (toolResult: unknown, isError: boolean) => {
					if (isError) {
						const message = extractToolText(toolResult) || `${SUBMIT_RESULT_TOOL} failed`
						result.stderr = result.stderr ? `${result.stderr.trim()}\n${message}` : message
						pushEvent(result, `✗ ${SUBMIT_RESULT_TOOL}`)
						return
					}

					const details = isRecord(toolResult) && isRecord(toolResult.details) ? toolResult.details : null
					const parsed = details ? parseSubmitResultPayload(details) : null
					if (!parsed) {
						const message = `${SUBMIT_RESULT_TOOL} returned invalid details`
						result.stderr = result.stderr ? `${result.stderr.trim()}\n${message}` : message
						pushEvent(result, `✗ ${SUBMIT_RESULT_TOOL}(invalid)`)
						return
					}

					submitResult = parsed
					const submitted = truncateWithArtifact(formatSubmitResult(parsed), cwd, input.agent)
					result.final = submitted.content
					result.outputPath = submitted.outputPath
					if (parsed.status === "aborted") {
						result.stderr = parsed.error || result.stderr
					}
					pushEvent(result, `✓ ${SUBMIT_RESULT_TOOL}(${parsed.status})`)
				}

				if (data.type === "tool_execution_start") {
					const toolName = asString(data.toolName) ?? "tool"
					const inputArgs = isRecord(data.args) ? data.args : {}
					pushEvent(result, `→ ${summarizeToolCall(toolName, inputArgs)}`)
					emit()
				}

				if (data.type === "tool_execution_end") {
					const toolName = asString(data.toolName) ?? "tool"
					if (toolName === SUBMIT_RESULT_TOOL) {
						captureSubmitResult(data.result, data.isError === true)
						emit()
					}
				}
			}

			proc.stdout.on("data", (chunk) => {
				buffer += chunk.toString()
				const lines = buffer.split("\n")
				buffer = lines.pop() || ""
				for (const line of lines) processLine(line)
			})

			proc.stderr.on("data", (chunk) => {
				result.stderr += chunk.toString()
			})

			proc.on("close", (code) => {
				if (spinnerTimer) {
					clearInterval(spinnerTimer)
					spinnerTimer = undefined
				}
				if (buffer.trim()) processLine(buffer)
				let exitCode = code ?? 1
				if (!aborted && !submitResult) {
					exitCode = 1
					const warning = `Subagent finished without calling ${SUBMIT_RESULT_TOOL}.`
					result.stderr = result.stderr ? `${result.stderr.trim()}\n${warning}` : warning
					if (!result.final) result.final = warning
					pushEvent(result, `✗ missing ${SUBMIT_RESULT_TOOL}`)
				}
				if (submitResult?.status === "aborted") {
					exitCode = 1
				}
				updateRun(runId, {
					status: aborted ? "aborted" : exitCode === 0 ? "done" : "failed",
					exitCode,
					endedAt: Date.now(),
					error: result.stderr.trim() || undefined,
				})
				resolve(exitCode)
			})

			proc.on("error", (err) => {
				if (spinnerTimer) {
					clearInterval(spinnerTimer)
					spinnerTimer = undefined
				}
				result.stderr += String(err)
				updateRun(runId, {
					status: "failed",
					exitCode: 1,
					endedAt: Date.now(),
					error: String(err),
				})
				resolve(1)
			})

			if (signal) {
				const abort = () => {
					aborted = true
					proc.kill("SIGTERM")
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL")
					}, 3000)
				}
				if (signal.aborted) abort()
				else signal.addEventListener("abort", abort, { once: true })
			}
		})
	} finally {
		if (spinnerTimer) {
			clearInterval(spinnerTimer)
			spinnerTimer = undefined
		}
		if (tmpPrompt)
			try {
				fs.unlinkSync(tmpPrompt)
			} catch {
				// ignore
			}
		if (tmpDir)
			try {
				fs.rmdirSync(tmpDir)
			} catch {
				// ignore
			}
	}

	if (aborted) throw new Error("Subagent execution aborted")
	if (!result.final && result.stderr) {
		const out = truncateWithArtifact(result.stderr, input.cwd ?? baseCwd, input.agent)
		result.final = out.content
		result.outputPath = out.outputPath
	}
	return result
}

async function executeWithRetry(
	baseCwd: string,
	agents: AgentConfig[],
	input: { agent: string; task: string; cwd?: string; step?: number },
	signal: AbortSignal | undefined,
	onUpdate: Update | undefined,
	buildDetails: (results: TaskResult[]) => Details,
) {
	const first = await runTask(baseCwd, agents, input, signal, onUpdate, buildDetails)
	const text = `${first.stderr}\n${first.final}`
	if (first.exitCode === 0) return first
	if (!/No API key found for/i.test(text)) return first
	await new Promise((resolve) => setTimeout(resolve, 500))
	return runTask(baseCwd, agents, input, signal, onUpdate, buildDetails)
}

async function parallelMap<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
) {
	if (items.length === 0) return []
	const limit = Math.max(1, Math.min(concurrency, items.length))
	const out = new Array<TOut>(items.length)
	let next = 0
	await Promise.all(
		new Array(limit).fill(null).map(async () => {
			while (true) {
				const index = next++
				if (index >= items.length) return
				out[index] = await fn(items[index], index)
			}
		}),
	)
	return out
}

function defaultAgent(agents: AgentConfig[], preferred: string | undefined) {
	if (preferred) {
		const found = agents.find((item) => item.name === preferred)
		if (found) return found.name
	}
	for (const name of ["worker", "general", "scout", "planner", "reviewer"]) {
		const found = agents.find((item) => item.name === name)
		if (found) return found.name
	}
	return agents[0]?.name
}
const TaskItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Subagent name (defaults automatically)" })),
	task: Type.String({ description: "Task for the subagent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory override" })),
})

const Params = Type.Object({
	agent: Type.Optional(Type.String({ description: "Single mode: subagent name" })),
	task: Type.Optional(Type.String({ description: "Single mode: task" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel mode" })),
	agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const, { default: "user" })),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "Prompt before executing project-local .pi/agents (default true)",
			default: true,
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Single mode working directory override" })),
})

function normalizeAgentScope(value: unknown): AgentScope {
	if (value === "project" || value === "both" || value === "user") return value
	return "user"
}

function isDetails(value: unknown): value is Details {
	if (!isRecord(value)) return false
	if (!Array.isArray(value.results)) return false
	if (value.mode !== "single" && value.mode !== "parallel") return false
	return true
}

export default function (pi: ExtensionAPI) {
	const guidanceSent = new Set<string>()
	const trustedProjectAgents = new Set<string>()

	pi.registerFlag("subagents-guidance", {
		description: "Inject one-time guidance message to steer the model toward efficient subagent usage",
		type: "boolean",
		default: true,
	})

	pi.registerFlag("subagents-default-agent", {
		description: "Default subagent name used when agent is omitted",
		type: "string",
		default: "worker",
	})

	pi.on("before_agent_start", async (_event, ctx) => {
		const enabled = Boolean(pi.getFlag("subagents-guidance"))
		if (!enabled) return
		const key = sessionKey(ctx)
		if (guidanceSent.has(key)) return
		guidanceSent.add(key)
		return {
			message: {
				customType: "subagents-guidance",
				content: guidance,
				display: false,
			},
		}
	})

	pi.registerCommand("subagents", {
		description: "List discovered subagents",
		handler: async (_args, ctx) => {
			const scope: AgentScope = "both"
			const found = discoverAgents(ctx.cwd, scope)
			if (found.agents.length === 0) {
				ctx.ui.notify("No agents found. Add files under ~/.pi/agent/agents or .pi/agents.", "warning")
				return
			}
			const lines = found.agents.map((agent) => `${agent.name} (${agent.source}) - ${agent.description}`)
			ctx.ui.notify(`Subagents (${found.agents.length}):\n${lines.join("\n")}`, "info")
		},
	})

	pi.registerCommand("subagents-running", {
		description: "Show subagent process runs (optionally filtered by query)",
		handler: async (args, ctx) => {
			const query = args.trim().toLowerCase()
			const items = runOrder
				.slice()
				.reverse()
				.map((id) => runs.get(id))
				.filter((item): item is RunInfo => Boolean(item))
				.filter((item) => {
					if (!query) return true
					const hay = [item.agent, item.task, item.cwd, item.status, String(item.pid ?? "")].join("\n").toLowerCase()
					return hay.includes(query)
				})

			if (items.length === 0) {
				const text = query ? `No subagent runs matching: ${args}` : "No subagent runs recorded yet."
				if (ctx.hasUI) ctx.ui.notify(text, "info")
				else console.log(text)
				return
			}

			const active = items.filter((item) => item.status === "queued" || item.status === "running").length
			const lines = items.slice(0, 40).map((item) => {
				const icon =
					item.status === "queued"
						? "…"
						: item.status === "running"
							? "▶"
							: item.status === "done"
								? "✓"
								: item.status === "aborted"
									? "■"
									: "✗"
				const pid = item.pid ? ` pid:${item.pid}` : ""
				const code = item.exitCode === undefined ? "" : ` exit:${item.exitCode}`
				return `${icon} #${item.id} ${item.agent}${pid}${code} ${elapsed(item)} ${item.status} :: ${trim(item.task, 100)}`
			})
			const text = `Subagent runs (${items.length}, active ${active})\n${lines.join("\n")}`

			if (ctx.hasUI) ctx.ui.notify(text, "info")
			else console.log(text)
		},
	})

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to isolated subagents (single or parallel).",
			"Use parallel tasks for independent work units.",
			"This tool is blocking: it streams progress and returns final results.",
			"Do NOT call this tool repeatedly to poll status.",
		].join(" "),
		promptSnippet: "Delegate tasks to isolated subagents",
		parameters: Params,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const mode = Number(Boolean(params.task && !params.tasks?.length)) + Number(Boolean(params.tasks?.length))
			const agentScope = normalizeAgentScope(params.agentScope)
			const found = discoverAgents(ctx.cwd, agentScope)
			const agents = found.agents
			const confirmProjectAgents = params.confirmProjectAgents ?? true
			const preferred = String(pi.getFlag("subagents-default-agent") || "")

			const details = (kind: Details["mode"], results: TaskResult[]): Details => ({
				mode: kind,
				agentScope,
				projectAgentsDir: found.projectAgentsDir,
				results,
			})

			if (mode !== 1) {
				return {
					content: [{ type: "text", text: "Provide exactly one mode: task OR tasks[]." }],
					details: details("single", []),
					isError: true,
				}
			}

			if (agents.length === 0) {
				return {
					content: [{ type: "text", text: "No subagents found. Add .md files in ~/.pi/agent/agents or .pi/agents." }],
					details: details("single", []),
					isError: true,
				}
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requested = new Set<string>()
				if (params.task && !params.tasks?.length) {
					const picked = params.agent ?? defaultAgent(agents, preferred)
					if (picked) requested.add(picked)
				}
				for (const item of params.tasks ?? []) {
					const picked = item.agent ?? defaultAgent(agents, preferred)
					if (picked) requested.add(picked)
				}

				const projectAgents = Array.from(requested)
					.map((name) => agents.find((agent) => agent.name === name))
					.filter((agent): agent is AgentConfig => agent?.source === "project")

				if (projectAgents.length > 0) {
					const detailsText = `Agents: ${projectAgents.map((agent) => agent.name).join(", ")}\nSource: ${found.projectAgentsDir ?? "unknown"}`
					const trustKey = `${sessionKey(ctx)}::${found.projectAgentsDir ?? "unknown"}`
					if (!trustedProjectAgents.has(trustKey)) {
						const choice = await ctx.ui.select(`Run project-local subagents?\n${detailsText}`, [
							"Allow once",
							"Always allow this session",
							"Cancel",
						])
						if (!choice || choice === "Cancel") {
							return {
								content: [{ type: "text", text: "Canceled by user." }],
								details: details("single", []),
								isError: true,
							}
						}
						if (choice === "Always allow this session") {
							trustedProjectAgents.add(trustKey)
						}
					}
				}
			}

			if (params.tasks?.length) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [
							{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` },
						],
						details: details("parallel", []),
						isError: true,
					}
				}

				const running = params.tasks.map<TaskResult>((item) => {
					const agent = item.agent ?? defaultAgent(agents, preferred) ?? "unknown"
					return {
						agent,
						agentSource: agents.find((found) => found.name === agent)?.source ?? "unknown",
						task: item.task,
						exitCode: -1,
						stderr: "",
						final: "",
						events: [],
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 },
					}
				})

				const emitParallel = () => {
					if (!onUpdate) return
					const snapshot = details("parallel", [...running])
					onUpdate({
						content: [{ type: "text", text: progress("parallel", snapshot.results) }],
						details: snapshot,
					})
				}

				const results = await parallelMap(params.tasks, MAX_CONCURRENCY, async (item, index) => {
					const picked = item.agent ?? defaultAgent(agents, preferred)
					if (!picked) {
						const failed: TaskResult = {
							agent: "unknown",
							agentSource: "unknown",
							task: item.task,
							exitCode: 1,
							stderr: "No agent available to run this task.",
							final: "",
							events: [],
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 },
						}
						running[index] = failed
						emitParallel()
						return failed
					}
					const done = await executeWithRetry(
						ctx.cwd,
						agents,
						{ agent: picked, task: item.task, cwd: item.cwd },
						signal,
						onUpdate
							? (partial) => {
									const current = partial.details?.results[0]
									if (!current) return
									running[index] = current
									emitParallel()
								}
							: undefined,
						(single) => details("parallel", single),
					)
					running[index] = done
					emitParallel()
					return done
				})

				const ok = results.filter((item) => item.exitCode === 0).length
				const summary = results
					.map(
						(item) =>
							`- [${item.agent}] ${item.exitCode === 0 ? "ok" : "failed"}: ${trim(item.final, 280) || "(no output)"}`,
					)
					.join("\n")
				return {
					content: [{ type: "text", text: `Parallel complete: ${ok}/${results.length} succeeded\n\n${summary}` }],
					details: details("parallel", results),
					isError: ok !== results.length,
				}
			}

			const picked = params.agent ?? defaultAgent(agents, preferred)
			if (!picked) {
				return {
					content: [{ type: "text", text: "No agent available to run this task." }],
					details: details("single", []),
					isError: true,
				}
			}

			if (!params.task) {
				return {
					content: [{ type: "text", text: "Single mode requires task." }],
					details: details("single", []),
					isError: true,
				}
			}

			const single = await executeWithRetry(
				ctx.cwd,
				agents,
				{ agent: picked, task: params.task, cwd: params.cwd },
				signal,
				onUpdate,
				(singleResults) => details("single", singleResults),
			)

			const failed = single.exitCode !== 0 || single.stopReason === "error" || single.stopReason === "aborted"
			return {
				content: [{ type: "text", text: single.final || "(no output)" }],
				details: details("single", [single]),
				isError: failed,
			}
		},

		renderCall(args, theme) {
			const scope = normalizeAgentScope(args.agentScope)
			if (args.tasks?.length) {
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) +
						theme.fg("accent", `parallel(${args.tasks.length})`) +
						theme.fg("muted", ` [${scope}]`),
					0,
					0,
				)
			}
			const agent = String(args.agent ?? `auto:${String(pi.getFlag("subagents-default-agent") || "worker")}`)
			return new Text(
				theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agent) + theme.fg("muted", ` [${scope}]`),
				0,
				0,
			)
		},

		renderResult(result, options, theme) {
			if (!isDetails(result.details) || result.details.results.length === 0) {
				const text = result.content.find((item) => item.type === "text")
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0)
			}
			const data = result.details

			const done = data.results.every((entry) => entry.exitCode !== -1)
			const total = formatUsage(totalUsage(data.results))
			const expanded = options.expanded
			if (!expanded) {
				const tick = Date.now()
				const rows = data.results.map((entry, index) => {
					const icon =
						entry.exitCode === -1
							? theme.fg("warning", marker(entry, tick))
							: entry.exitCode === 0
								? theme.fg("success", marker(entry, tick))
								: theme.fg("error", marker(entry, tick))
					const branch = theme.fg("dim", index === data.results.length - 1 ? "└" : "├")
					const label = theme.fg("accent", entry.step ? `${entry.agent}(${entry.step})` : entry.agent)
					const first = entry.events.at(-1) || entry.final || "(no output)"
					const tools = countToolEvents(entry)
					const usage = formatUsage(entry.usage)
					const meta = [tools > 0 ? `${tools} tools` : "", usage].filter(Boolean).join(" · ")
					const metaText = meta ? `${theme.fg("dim", ` · ${meta}`)}` : ""
					return `${branch} ${icon} ${label}: ${theme.fg("muted", trim(first, 120))}${metaText}`
				})
				const doneCount = data.results.filter((entry) => entry.exitCode === 0).length
				const failedCount = data.results.filter((entry) => entry.exitCode > 0).length
				const runningCount = data.results.length - doneCount - failedCount
				const liveTotal = total ? ` · ${done ? total : `live ${total}`}` : ""
				const summary = theme.fg(
					"dim",
					`total ${doneCount} done · ${runningCount} running · ${failedCount} failed${liveTotal}`,
				)
				return new Text([summary, ...rows].join("\n"), 0, 0)
			}

			const mdTheme = getMarkdownTheme()
			const box = new Container()
			const tick = Date.now()
			for (const [index, entry] of data.results.entries()) {
				const icon =
					entry.exitCode === -1
						? theme.fg("warning", marker(entry, tick))
						: entry.exitCode === 0
							? theme.fg("success", marker(entry, tick))
							: theme.fg("error", marker(entry, tick))
				const branch = theme.fg("dim", index === data.results.length - 1 ? "└" : "├")
				const continuePrefix = index === data.results.length - 1 ? "   " : "│  "
				const tools = countToolEvents(entry)
				const usage = formatUsage(entry.usage)
				const meta = [tools > 0 ? `${tools} tools` : "", usage].filter(Boolean).join(" · ")

				box.addChild(
					new Text(
						`${branch} ${icon} ${theme.fg("toolTitle", theme.bold(entry.step ? `${entry.agent}(${entry.step})` : entry.agent))}${theme.fg("muted", ` (${entry.agentSource})`)}${meta ? theme.fg("dim", ` · ${meta}`) : ""}`,
						0,
						0,
					),
				)
				box.addChild(new Text(theme.fg("dim", `${continuePrefix}↳ task: ${trim(entry.task, 160)}`), 0, 0))
				for (const line of entry.events) {
					box.addChild(new Text(theme.fg("muted", `${continuePrefix}↳ ${line}`), 0, 0))
				}
				if (entry.final) {
					box.addChild(new Spacer(1))
					box.addChild(new Markdown(entry.final, 0, 0, mdTheme))
				}
				if (entry.outputPath)
					box.addChild(new Text(theme.fg("dim", `${continuePrefix}↳ artifact: ${entry.outputPath}`), 0, 0))
				box.addChild(new Spacer(1))
			}
			if (total) {
				box.addChild(new Text(theme.fg("toolTitle", theme.bold(done ? "Total" : "Live total")), 0, 0))
				box.addChild(new Text(theme.fg("dim", total), 0, 0))
			}
			return box
		},
	})
}

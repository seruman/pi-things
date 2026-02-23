import { spawn as nodeSpawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { SubagentRegistry } from "./registry"
import type { SubagentEntry } from "./types"

const DEFAULT_SYSTEM_PROMPT = `You are a focused subagent. Complete the given task efficiently.
Do not attempt to spawn subagents. Use available tools to accomplish your work.
When working with tasks, claim them before starting and mark them completed when done.`

const GRACE_PERIOD_MS = 5000

interface SpawnOptions {
	cwd: string
	prompt: string
	taskId?: string
	systemPrompt?: string
	model?: string
	thinking?: string
	timeout: number
	parentSessionId?: string
	registry: SubagentRegistry
}

function discoverExtensions(cwd: string, selfPath: string): string[] {
	try {
		const pkgPath = resolve(cwd, "package.json")
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
		const extensions: string[] = pkg?.pi?.extensions ?? []
		return extensions.map((e: string) => resolve(cwd, e)).filter((e: string) => !e.includes("subagent-tools"))
	} catch {
		return []
	}
}

function buildPrompt(prompt: string, taskId?: string): string {
	if (taskId) {
		return `You are a subagent working on task #${taskId}.
Do the assigned work and report concise results.
Do NOT manage task status/ownership yourself; the orchestrator will handle that.

${prompt}`
	}
	return `You are a subagent.

${prompt}`
}

function buildArgs(options: SpawnOptions, extensions: string[]): string[] {
	const fullPrompt = buildPrompt(options.prompt, options.taskId)
	const args = ["-p", fullPrompt, "--no-prompt-templates", "--no-themes", "--no-session"]

	const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
	args.push("--system-prompt", systemPrompt)

	if (options.model) {
		args.push("--model", options.model)
	}

	if (options.thinking) {
		args.push("--thinking", options.thinking)
	}

	for (const ext of extensions) {
		args.push("-e", ext)
	}

	return args
}

function buildEnv(agentId: string, parentSessionId?: string): Record<string, string | undefined> {
	return {
		...process.env,
		PI_SUBAGENT_DEPTH: "1",
		PI_PARENT_SESSION_ID: parentSessionId ?? "",
		PI_SUBAGENT_ID: agentId,
		TASK_LIST_ID: process.env.TASK_LIST_ID ?? "default",
	}
}

export function spawnSubagent(options: SpawnOptions): SubagentEntry {
	const agentId = randomUUID().slice(0, 8)
	const extensions = discoverExtensions(options.cwd, "")

	const args = buildArgs(options, extensions)
	const env = buildEnv(agentId, options.parentSessionId)

	const child = nodeSpawn("pi", args, {
		cwd: options.cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: false,
	})

	const entry: SubagentEntry = {
		agentId,
		pid: child.pid ?? -1,
		taskId: options.taskId,
		process: child,
		status: "running",
		stdout: "",
		stderr: "",
		startedAt: Date.now(),
		timeout: options.timeout,
		model: options.model,
		outputFile: options.registry.outputFilePath(agentId),
	}

	options.registry.add(entry)

	child.stdout?.on("data", (data: Buffer) => {
		options.registry.appendStdout(agentId, data.toString())
	})

	child.stderr?.on("data", (data: Buffer) => {
		options.registry.appendStderr(agentId, data.toString())
	})

	child.on("close", (code) => {
		const current = options.registry.get(agentId)
		if (current && current.status === "running") {
			options.registry.updateStatus(agentId, code === 0 ? "completed" : "failed", code ?? 1)
		}
	})

	child.on("error", (err) => {
		const current = options.registry.get(agentId)
		if (current && current.status === "running") {
			options.registry.appendStderr(agentId, `spawn error: ${err.message}\n`)
			options.registry.updateStatus(agentId, "failed", 1)
		}
	})

	// Wall-clock timeout
	entry.timeoutTimer = setTimeout(() => {
		const current = options.registry.get(agentId)
		if (current && current.status === "running") {
			killGracefully(current)
			options.registry.updateStatus(agentId, "timeout", 1)
		}
	}, options.timeout * 1000)

	return entry
}

export function killGracefully(entry: SubagentEntry): void {
	const pid = entry.process.pid
	if (!pid) return

	// Kill the entire process tree
	killTree(pid, "SIGTERM")

	setTimeout(() => {
		try {
			if (!entry.process.killed) {
				killTree(pid, "SIGKILL")
			}
		} catch {
			// already dead
		}
	}, GRACE_PERIOD_MS)
}

function killTree(pid: number, signal: string): void {
	try {
		// Find all descendant PIDs recursively via pgrep
		const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf-8" })
		if (result.stdout) {
			for (const childPidStr of result.stdout.trim().split("\n")) {
				const childPid = Number(childPidStr)
				if (childPid > 0) killTree(childPid, signal)
			}
		}
		// Kill the process itself
		process.kill(pid, signal as NodeJS.Signals)
	} catch {
		// process may already be dead
	}
}

export function waitForExit(entry: SubagentEntry): Promise<void> {
	if (entry.status !== "running") return Promise.resolve()

	return new Promise((resolve) => {
		entry.process.on("close", () => resolve())
		entry.process.on("error", () => resolve())
	})
}

export function waitForExitOrTimeout(entry: SubagentEntry, timeoutMs: number): Promise<boolean> {
	if (entry.status !== "running") return Promise.resolve(true)

	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs)
		const done = () => {
			clearTimeout(timer)
			resolve(true)
		}
		entry.process.on("close", done)
		entry.process.on("error", done)
	})
}

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { z } from "zod"
import { getDbIfExists, getListId, getTask, runWithListLock, updateTaskFields } from "../task-tools/db"
import { claimTaskOwnership, releaseTaskOwnership } from "../task-tools/ownership"
import { registerCleanup } from "./cleanup"
import type { SubagentRegistry } from "./registry"
import { killGracefully, spawnSubagent, waitForExit, waitForExitOrTimeout } from "./spawn"
import { renderSubagentCall, renderSubagentResult } from "./subagent-ui"
import type { SubagentAction, SubagentToolResult } from "./types"

const MAX_CONCURRENT_DEFAULT = 5
const DEFAULT_TIMEOUT = 300

const params = Type.Object(
	{
		action: Type.Union([
			Type.Literal("spawn"),
			Type.Literal("status"),
			Type.Literal("output"),
			Type.Literal("stop"),
			Type.Literal("list"),
		]),
		prompt: Type.Optional(Type.String({ description: "Instruction for the subagent (spawn)" })),
		taskId: Type.Optional(Type.String({ description: "Task ID to auto-claim (spawn)" })),
		background: Type.Optional(Type.Boolean({ description: "Return immediately (spawn, default: false)" })),
		systemPrompt: Type.Optional(Type.String({ description: "Custom system prompt (spawn)" })),
		model: Type.Optional(Type.String({ description: "Model override (spawn)" })),
		thinking: Type.Optional(Type.String({ description: "Thinking level override (spawn)" })),
		maxTurns: Type.Optional(Type.Number({ description: "Max model turns (spawn, default: 30)" })),
		timeout: Type.Optional(Type.Number({ description: "Wall-clock timeout seconds (spawn: 300, output: 30)" })),
		agentId: Type.Optional(Type.String({ description: "Agent ID (status/output/stop)" })),
		block: Type.Optional(Type.Boolean({ description: "Wait for completion (output, default: false)" })),
	},
	{ additionalProperties: false },
)

const inputSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("spawn"),
		prompt: z.string().min(1),
		taskId: z.string().optional(),
		background: z.boolean().optional(),
		systemPrompt: z.string().optional(),
		model: z.string().optional(),
		thinking: z.string().optional(),
		maxTurns: z.number().positive().optional(),
		timeout: z.number().positive().optional(),
	}),
	z.object({ action: z.literal("status"), agentId: z.string() }),
	z.object({
		action: z.literal("output"),
		agentId: z.string(),
		block: z.boolean().optional(),
		timeout: z.number().positive().optional(),
	}),
	z.object({ action: z.literal("stop"), agentId: z.string() }),
	z.object({ action: z.literal("list") }),
])

const actionSchema = z.enum(["spawn", "status", "output", "stop", "list"])

function fail(action: SubagentAction, error: string) {
	return {
		content: [{ type: "text" as const, text: `Error: ${error}` }],
		isError: true as const,
		details: { action, error } as SubagentToolResult,
	}
}

export function registerSubagentTool(pi: ExtensionAPI, registry: SubagentRegistry) {
	registerCleanup(registry)

	const maxConcurrent = Number(process.env.PI_SUBAGENT_MAX_CONCURRENT) || MAX_CONCURRENT_DEFAULT

	pi.registerTool<typeof params, SubagentToolResult>({
		name: "subagent",
		label: "Subagent",
		description: "Spawn and manage parallel subagent processes: spawn/status/output/stop/list",
		parameters: params,
		async execute(_toolCallId, p, signal: AbortSignal | undefined, _onUpdate, ctx: ExtensionContext) {
			const fallbackAction: SubagentAction = actionSchema.safeParse(p.action).success
				? (p.action as SubagentAction)
				: "list"
			const parsed = inputSchema.safeParse(p)
			if (!parsed.success) {
				const reason = parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ")
				return fail(fallbackAction, `invalid arguments for action '${String(p.action)}' (${reason})`)
			}

			const input = parsed.data

			switch (input.action) {
				case "spawn": {
					if (registry.runningCount() >= maxConcurrent) {
						return fail(
							"spawn",
							`max concurrent subagents reached (${maxConcurrent}). Wait for existing agents to finish.`,
						)
					}

					const timeout = input.timeout ?? DEFAULT_TIMEOUT
					const sessionId = ctx.sessionManager.getSessionId?.()

					const entry = spawnSubagent({
						cwd: ctx.cwd,
						prompt: input.prompt,
						taskId: input.taskId,
						systemPrompt: input.systemPrompt,
						model: input.model,
						thinking: input.thinking,
						timeout,
						parentSessionId: sessionId,
						registry,
					})

					if (input.taskId) {
						const taskId = Number(input.taskId)
						if (!Number.isInteger(taskId) || taskId <= 0) {
							killGracefully(entry)
							registry.updateStatus(entry.agentId, "stopped", 1)
							registry.evict(entry.agentId)
							return fail("spawn", `invalid taskId '${input.taskId}'`)
						}
						const taskErr = await markTaskInProgressForAgent(ctx, taskId, entry.agentId)
						if (taskErr) {
							killGracefully(entry)
							registry.updateStatus(entry.agentId, "stopped", 1)
							registry.evict(entry.agentId)
							return fail("spawn", taskErr)
						}
					}

					if (input.background) {
						return {
							content: [
								{
									type: "text",
									text: `Subagent ${entry.agentId} spawned (pid:${entry.pid})${input.taskId ? ` for task #${input.taskId}` : ""}\nOutput file: ${entry.outputFile}`,
								},
							],
							details: {
								action: "spawn",
								agentId: entry.agentId,
								pid: entry.pid,
								taskId: input.taskId,
								status: "running",
								outputFile: entry.outputFile,
							},
						}
					}

					// Blocking mode — wait for exit or abort
					const abortHandler = () => {
						const current = registry.get(entry.agentId)
						if (current && current.status === "running") {
							killGracefully(current)
							registry.updateStatus(entry.agentId, "stopped", 1)
						}
					}
					signal?.addEventListener("abort", abortHandler, { once: true })

					await waitForExit(entry)
					signal?.removeEventListener("abort", abortHandler)

					const final = registry.get(entry.agentId)
					if (!final) return fail("spawn", "agent entry lost")
					const durationMs = registry.getDuration(final)
					const output = registry.readOutputFile(final.agentId)
					const error = registry.readErrorFile(final.agentId) || undefined

					if (input.taskId) {
						await finalizeTaskForAgent(
							ctx,
							Number(input.taskId),
							`subagent:${final.agentId}`,
							final.exitCode === 0,
							output,
						)
					}

					// Evict blocking agents after returning — output is in the response + on disk
					registry.evict(entry.agentId)

					return {
						content: [{ type: "text", text: output || "(no output)" }],
						details: {
							action: "spawn",
							agentId: final.agentId,
							pid: final.pid,
							exitCode: final.exitCode ?? 1,
							output,
							error,
							durationMs,
							taskId: input.taskId,
							outputFile: final.outputFile,
						},
					}
				}

				case "status": {
					const entry = registry.get(input.agentId)
					if (!entry) return fail("status", `agent '${input.agentId}' not found`)

					return {
						content: [{ type: "text", text: `Agent ${entry.agentId} (pid:${entry.pid}): ${entry.status}` }],
						details: {
							action: "status",
							agentId: entry.agentId,
							status: entry.status,
							exitCode: entry.exitCode,
							durationMs: registry.getDuration(entry),
							taskId: entry.taskId,
							pid: entry.pid,
							outputFile: entry.outputFile,
						},
					}
				}

				case "output": {
					const entry = registry.get(input.agentId)
					if (!entry) return fail("output", `agent '${input.agentId}' not found`)

					if (input.block && entry.status === "running") {
						const timeoutMs = (input.timeout ?? 30) * 1000
						await waitForExitOrTimeout(entry, timeoutMs)
					}

					const current = registry.get(entry.agentId)
					if (!current) return fail("output", `agent '${input.agentId}' entry lost`)

					const output = registry.readOutputFile(current.agentId)
					const error = registry.readErrorFile(current.agentId) || undefined

					// Finalize task + evict completed background agents after output is consumed
					if (current.status !== "running") {
						if (current.taskId) {
							await finalizeTaskForAgent(
								ctx,
								Number(current.taskId),
								`subagent:${current.agentId}`,
								current.exitCode === 0,
								output,
							)
						}
						registry.evict(current.agentId)
					}

					return {
						content: [{ type: "text", text: output || "(no output yet)" }],
						details: {
							action: "output",
							agentId: current.agentId,
							status: current.status,
							output,
							error,
							exitCode: current.exitCode,
							ready: current.status !== "running",
							pid: current.pid,
							outputFile: current.outputFile,
						},
					}
				}

				case "stop": {
					const entry = registry.get(input.agentId)
					if (!entry) return fail("stop", `agent '${input.agentId}' not found`)

					if (entry.status === "running") {
						killGracefully(entry)
						registry.updateStatus(entry.agentId, "stopped", 1)
					}
					if (entry.taskId) {
						await finalizeTaskForAgent(ctx, Number(entry.taskId), `subagent:${entry.agentId}`, false, entry.stdout)
					}

					// Evict stopped agents
					registry.evict(entry.agentId)

					return {
						content: [{ type: "text", text: `Agent ${entry.agentId} (pid:${entry.pid}) stopped` }],
						details: {
							action: "stop",
							agentId: entry.agentId,
							status: "stopped",
							output: entry.stdout || undefined,
							pid: entry.pid,
						},
					}
				}

				case "list": {
					const agents = registry.all().map((e) => ({
						agentId: e.agentId,
						status: e.status,
						taskId: e.taskId,
						durationMs: registry.getDuration(e),
						exitCode: e.exitCode,
						pid: e.pid,
						model: e.model,
					}))

					if (!agents.length) {
						return {
							content: [{ type: "text", text: "No subagents" }],
							details: { action: "list", agents },
						}
					}

					const lines = agents.map((a) => {
						const task = a.taskId ? ` #${a.taskId}` : ""
						const dur = formatDuration(a.durationMs ?? 0)
						return `[${a.status}] ${a.agentId}${task} ${dur} pid:${a.pid}`
					})

					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { action: "list", agents },
					}
				}
			}
		},
		renderCall(args, theme) {
			return renderSubagentCall(args, theme)
		},
		renderResult(result, options, theme) {
			return renderSubagentResult(result, options, theme)
		},
	})
}

async function markTaskInProgressForAgent(
	ctx: ExtensionContext,
	taskId: number,
	agentId: string,
): Promise<string | null> {
	const db = getDbIfExists(ctx.cwd)
	if (!db) return "task-tools database not found"
	const listId = getListId()
	const task = getTask(db, listId, taskId)
	if (!task) return `task #${taskId} not found`
	try {
		await claimTaskOwnership({
			db,
			cwd: ctx.cwd,
			listId,
			taskId,
			sessionId: `subagent:${agentId}`,
			ctx,
		})
		await runWithListLock(ctx.cwd, listId, ctx, () => {
			updateTaskFields(db, listId, taskId, {
				status: "in_progress",
				activeForm: `Subagent ${agentId} working`,
			})
		})
		return null
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
}

async function finalizeTaskForAgent(
	ctx: ExtensionContext,
	taskId: number,
	agentOwner: string,
	success: boolean,
	output: string,
): Promise<void> {
	if (!Number.isInteger(taskId) || taskId <= 0) return
	const db = getDbIfExists(ctx.cwd)
	if (!db) return
	const listId = getListId()
	const task = getTask(db, listId, taskId)
	if (!task) return

	try {
		await runWithListLock(ctx.cwd, listId, ctx, () => {
			if (success) {
				updateTaskFields(db, listId, taskId, {
					status: "completed",
					activeForm: null,
					owner: null,
				})
			} else {
				updateTaskFields(db, listId, taskId, {
					status: "pending",
					activeForm: null,
					owner: null,
				})
			}
		})
	} catch {
		// best-effort
	}

	try {
		await releaseTaskOwnership({
			db,
			cwd: ctx.cwd,
			listId,
			taskId,
			sessionId: agentOwner,
			force: true,
			ctx,
		})
	} catch {
		// best-effort
	}

	void output
}

function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000)
	if (s < 60) return `${s}s`
	const m = Math.floor(s / 60)
	const rem = s % 60
	return `${m}m ${rem}s`
}

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { Type } from "typebox"
import { z } from "zod"
import {
	addDependency,
	createTask,
	deleteTask,
	filterBlockedBy,
	getCompletedTaskIds,
	getDb,
	getListId,
	getTask,
	listTasksWithIssues,
	purgeTasks,
	runWithListLock,
	taskExists,
	updateTaskFields,
} from "./db"
import { ownerAssignedSuffix, ownerDisplay } from "./owner-format"
import { claimTaskOwnership, releaseTaskOwnership } from "./ownership"
import { renderTaskCall, renderTaskResult } from "./task-ui"
import type { TaskAction, TaskErrorDetails, TaskStatus, TaskToolDetails, TaskToolInput } from "./types"

const params = Type.Object(
	{
		action: Type.Union([
			Type.Literal("list"),
			Type.Literal("get"),
			Type.Literal("create"),
			Type.Literal("update"),
			Type.Literal("claim"),
			Type.Literal("release"),
			Type.Literal("purge"),
		]),
		taskId: Type.Optional(Type.String({ description: "Task ID for get/update/claim/release" })),
		subject: Type.Optional(Type.String({ description: "Task title for create/update" })),
		description: Type.Optional(Type.String({ description: "Task description for create/update" })),
		activeForm: Type.Optional(Type.String({ description: 'Present continuous form (e.g. "Running tests")' })),
		status: Type.Optional(
			Type.Union([
				Type.Literal("pending"),
				Type.Literal("in_progress"),
				Type.Literal("completed"),
				Type.Literal("deleted"),
			]),
		),
		addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task blocks (update)" })),
		addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs blocking this task (update)" })),
		metadata: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), { description: "Task metadata for create/update" }),
		),
		includeCompletedBlockers: Type.Optional(
			Type.Boolean({ description: "Include completed blockers in get/list (default: false)" }),
		),
		force: Type.Optional(Type.Boolean({ description: "Override ownership checks for claim/release" })),
		scope: Type.Optional(Type.Union([Type.Literal("completed"), Type.Literal("all")], { description: "Purge scope" })),
		confirm: Type.Optional(Type.Boolean({ description: "Must be true for purge" })),
	},
	{ additionalProperties: false },
)

const taskActionSchema = z.enum(["list", "get", "create", "update", "claim", "release", "purge"])

const taskInputSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("list"), includeCompletedBlockers: z.boolean().optional() }).strict(),
	z.object({ action: z.literal("get"), taskId: z.string(), includeCompletedBlockers: z.boolean().optional() }).strict(),
	z
		.object({
			action: z.literal("create"),
			subject: z.string(),
			description: z.string(),
			activeForm: z.string().optional(),
			metadata: z.record(z.string(), z.unknown()).optional(),
		})
		.strict(),
	z
		.object({
			action: z.literal("update"),
			taskId: z.string(),
			subject: z.string().optional(),
			description: z.string().optional(),
			activeForm: z.string().optional(),
			status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional(),
			addBlocks: z.array(z.string()).optional(),
			addBlockedBy: z.array(z.string()).optional(),
			metadata: z.record(z.string(), z.unknown()).optional(),
		})
		.strict(),
	z.object({ action: z.literal("claim"), taskId: z.string(), force: z.boolean().optional() }).strict(),
	z.object({ action: z.literal("release"), taskId: z.string(), force: z.boolean().optional() }).strict(),
	z
		.object({
			action: z.literal("purge"),
			scope: z.enum(["completed", "all"]).optional(),
			confirm: z.boolean(),
		})
		.strict(),
])

type RuntimeTaskInput = z.infer<typeof taskInputSchema>

function isTaskAction(value: unknown): value is TaskAction {
	return taskActionSchema.safeParse(value).success
}

function fail(action: TaskAction, error: string, details: Omit<Partial<TaskErrorDetails>, "action" | "error"> = {}) {
	const errorDetails: TaskErrorDetails = { action, error, ...details }
	return {
		content: [{ type: "text" as const, text: `Error: ${error}` }],
		isError: true as const,
		details: errorDetails,
	}
}

function parseTaskId(taskId: string): number | null {
	const id = Number(taskId.trim())
	if (!Number.isFinite(id) || id <= 0) return null
	return id
}

export function registerTaskTool(pi: ExtensionAPI) {
	pi.registerTool<typeof params, TaskToolDetails>({
		name: "task",
		label: "Task",
		description: "Manage tasks: list/get/create/update/claim/release/purge",
		promptSnippet: "Manage persistent tasks and dependencies",
		parameters: params,
		async execute(_toolCallId, p, _signal, _onUpdate, ctx: ExtensionContext) {
			const fallbackAction: TaskAction = isTaskAction(p.action) ? p.action : "list"
			const parsed = taskInputSchema.safeParse(p)
			if (!parsed.success) {
				const reason = parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ")
				return fail(fallbackAction, `invalid arguments for action '${String(p.action)}' (${reason})`)
			}

			const input: RuntimeTaskInput = parsed.data
			const db = getDb(ctx.cwd)
			const listId = getListId()
			const currentSessionId = ctx.sessionManager.getSessionId?.()

			switch (input.action) {
				case "list": {
					const { tasks, issues } = listTasksWithIssues(db, listId)
					if (!input.includeCompletedBlockers) {
						const completedIds = getCompletedTaskIds(db, listId)
						for (const task of tasks) task.blockedBy = filterBlockedBy(task.blockedBy, completedIds)
					}

					const counts = {
						total: tasks.length,
						pending: tasks.filter((t) => t.status === "pending").length,
						inProgress: tasks.filter((t) => t.status === "in_progress").length,
						completed: tasks.filter((t) => t.status === "completed").length,
					}

					if (!tasks.length) {
						const warning = issues.length ? `\n\nWarning: skipped ${issues.length} broken task file(s)` : ""
						return {
							content: [{ type: "text", text: `No tasks${warning}` }],
							details: { action: "list", tasks, counts, issues, currentSessionId },
						}
					}

					const lines = tasks.map((t) => {
						const blocked = t.blockedBy.length ? ` [blocked by ${t.blockedBy.map((id) => `#${id}`).join(", ")}]` : ""
						return `#${t.id} [${t.status}] ${t.subject}${ownerAssignedSuffix(t.owner, currentSessionId)}${blocked}`
					})
					if (issues.length) lines.push(`\nWarning: skipped ${issues.length} broken task file(s)`)

					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { action: "list", tasks, counts, issues, currentSessionId },
					}
				}

				case "get": {
					const numId = parseTaskId(input.taskId)
					if (!numId) return fail("get", "taskId must be a positive number", { taskId: input.taskId })

					let task: ReturnType<typeof getTask>
					try {
						task = getTask(db, listId, numId)
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error)
						return fail("get", `Task #${input.taskId} is unreadable (invalid task file format). Details: ${message}`, {
							taskId: input.taskId,
						})
					}
					if (!task) return fail("get", `Task #${input.taskId} not found`, { taskId: input.taskId })

					if (!input.includeCompletedBlockers) {
						const completedIds = getCompletedTaskIds(db, listId)
						task.blockedBy = filterBlockedBy(task.blockedBy, completedIds)
					}

					const lines = [
						`Task #${task.id}: ${task.subject}`,
						`Status: ${task.status}`,
						`Description: ${task.description}`,
					]
					if (task.owner)
						lines.push(`Owner: ${ownerDisplay(task.owner, currentSessionId, { includeCurrentSessionId: true })}`)
					if (task.blockedBy.length) lines.push(`Blocked by: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`)
					if (task.blocks.length) lines.push(`Blocks: ${task.blocks.map((id) => `#${id}`).join(", ")}`)

					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { action: "get", task, taskId: String(task.id), currentSessionId },
					}
				}

				case "create": {
					const subject = input.subject.trim()
					const description = input.description.trim()
					if (!subject) return fail("create", "subject is required")
					if (!description) return fail("create", "description is required")

					try {
						const task = await runWithListLock(ctx.cwd, listId, ctx, () =>
							createTask(db, listId, {
								subject,
								description,
								activeForm: input.activeForm,
								metadata: input.metadata,
							}),
						)
						return {
							content: [{ type: "text", text: `Task #${task.id} created: ${task.subject}` }],
							details: { action: "create", task, taskId: String(task.id) },
						}
					} catch (error) {
						return fail("create", error instanceof Error ? error.message : String(error))
					}
				}

				case "update": {
					const numId = parseTaskId(input.taskId)
					if (!numId) return fail("update", "taskId must be a positive number", { taskId: input.taskId })
					const taskId = input.taskId

					const existing = getTask(db, listId, numId)
					if (!existing) return fail("update", `Task #${taskId} not found`, { taskId })

					if (input.status === "deleted") {
						try {
							const ok = await runWithListLock(ctx.cwd, listId, ctx, () => deleteTask(db, listId, numId))
							if (!ok) return fail("update", `Failed to delete task #${taskId}`, { taskId })
							return {
								content: [{ type: "text", text: `Deleted task #${taskId}` }],
								details: {
									action: "update",
									taskId,
									deleted: true,
									statusChange: { from: existing.status, to: "deleted" },
								},
							}
						} catch (error) {
							return fail("update", error instanceof Error ? error.message : String(error), { taskId })
						}
					}

					const updatedFields: string[] = []
					const fieldUpdates: Parameters<typeof updateTaskFields>[3] = {}

					if (input.subject !== undefined) {
						const subject = input.subject.trim()
						if (!subject) return fail("update", "subject cannot be empty", { taskId })
						if (subject !== existing.subject) {
							fieldUpdates.subject = subject
							updatedFields.push("subject")
						}
					}
					if (input.description !== undefined) {
						const description = input.description.trim()
						if (!description) return fail("update", "description cannot be empty", { taskId })
						if (description !== existing.description) {
							fieldUpdates.description = description
							updatedFields.push("description")
						}
					}
					if (input.activeForm !== undefined) {
						fieldUpdates.activeForm = input.activeForm || null
						updatedFields.push("activeForm")
					}
					if (input.status !== undefined && input.status !== existing.status) {
						if (input.status === "pending" || input.status === "in_progress" || input.status === "completed") {
							const status: TaskStatus = input.status
							fieldUpdates.status = status
							updatedFields.push("status")
						}
					}
					if (input.metadata !== undefined) {
						const merged = { ...(existing.metadata ?? {}) }
						for (const [key, value] of Object.entries(input.metadata)) {
							if (value === null || value === undefined) delete merged[key]
							else merged[key] = value
						}
						fieldUpdates.metadata = Object.keys(merged).length > 0 ? merged : null
						updatedFields.push("metadata")
					}

					const blockIds: number[] = []
					for (const blockedIdStr of input.addBlocks ?? []) {
						const blockedId = Number(blockedIdStr)
						if (!Number.isFinite(blockedId) || blockedId <= 0)
							return fail("update", `Invalid dependency ID: ${blockedIdStr}`, { taskId })
						if (blockedId === numId) return fail("update", "Task cannot block itself", { taskId })
						blockIds.push(blockedId)
					}
					if (blockIds.length) updatedFields.push("blocks")

					const blockedByIds: number[] = []
					for (const blockerIdStr of input.addBlockedBy ?? []) {
						const blockerId = Number(blockerIdStr)
						if (!Number.isFinite(blockerId) || blockerId <= 0)
							return fail("update", `Invalid dependency ID: ${blockerIdStr}`, { taskId })
						if (blockerId === numId) return fail("update", "Task cannot be blocked by itself", { taskId })
						blockedByIds.push(blockerId)
					}
					if (blockedByIds.length) updatedFields.push("blockedBy")

					try {
						await runWithListLock(ctx.cwd, listId, ctx, () => {
							for (const blockedId of blockIds) {
								if (!taskExists(db, listId, blockedId)) throw new Error(`Task #${blockedId} not found`)
							}
							for (const blockerId of blockedByIds) {
								if (!taskExists(db, listId, blockerId)) throw new Error(`Task #${blockerId} not found`)
							}

							if (Object.keys(fieldUpdates).length > 0) {
								const ok = updateTaskFields(db, listId, numId, fieldUpdates)
								if (!ok) throw new Error(`Task #${taskId} not found`)
							}

							for (const blockedId of blockIds) addDependency(db, listId, numId, blockedId)
							for (const blockerId of blockedByIds) addDependency(db, listId, blockerId, numId)
						})
					} catch (error) {
						return fail("update", error instanceof Error ? error.message : String(error), { taskId })
					}

					let text = `Updated task #${taskId}`
					if (updatedFields.length) text += `: ${updatedFields.join(", ")}`

					return {
						content: [{ type: "text", text }],
						details: {
							action: "update",
							taskId,
							updatedFields,
							statusChange: fieldUpdates.status ? { from: existing.status, to: fieldUpdates.status } : undefined,
						},
					}
				}

				case "claim": {
					const numId = parseTaskId(input.taskId)
					if (!numId) return fail("claim", "taskId must be a positive number", { taskId: input.taskId })
					if (!currentSessionId) return fail("claim", "session id unavailable", { taskId: input.taskId })

					try {
						await claimTaskOwnership({
							db,
							cwd: ctx.cwd,
							listId,
							taskId: numId,
							sessionId: currentSessionId,
							force: input.force,
							ctx,
						})
						return {
							content: [{ type: "text", text: `Claimed task #${input.taskId} for session ${currentSessionId}` }],
							details: { action: "claim", taskId: input.taskId, owner: currentSessionId, currentSessionId },
						}
					} catch (error) {
						return fail("claim", error instanceof Error ? error.message : String(error), { taskId: input.taskId })
					}
				}

				case "release": {
					const numId = parseTaskId(input.taskId)
					if (!numId) return fail("release", "taskId must be a positive number", { taskId: input.taskId })
					if (!currentSessionId) return fail("release", "session id unavailable", { taskId: input.taskId })

					try {
						await releaseTaskOwnership({
							db,
							cwd: ctx.cwd,
							listId,
							taskId: numId,
							sessionId: currentSessionId,
							force: input.force,
							ctx,
						})
						return {
							content: [{ type: "text", text: `Released task #${input.taskId}` }],
							details: { action: "release", taskId: input.taskId, owner: null, currentSessionId },
						}
					} catch (error) {
						return fail("release", error instanceof Error ? error.message : String(error), { taskId: input.taskId })
					}
				}

				case "purge": {
					const scope = input.scope ?? "completed"
					if (!input.confirm) return fail("purge", "set confirm=true to purge tasks", { scope })

					try {
						const deleted = await runWithListLock(ctx.cwd, listId, ctx, () => purgeTasks(db, listId, scope))
						return {
							content: [{ type: "text", text: `Purged ${deleted} task(s) from list '${listId}' (${scope})` }],
							details: { action: "purge", scope, deletedCount: deleted },
						}
					} catch (error) {
						return fail("purge", error instanceof Error ? error.message : String(error), { scope })
					}
				}
			}
		},
		renderCall(args: TaskToolInput, theme) {
			return renderTaskCall(args, theme)
		},
		renderResult(result, options, theme) {
			return renderTaskResult(result, options, theme)
		},
	})
}

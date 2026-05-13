import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import {
	createTask,
	deleteTask,
	getDb,
	getListId,
	getTask,
	listTasksWithIssues,
	purgeTasks,
	runWithListLock,
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
		status: Type.Optional(
			Type.Union([
				Type.Literal("pending"),
				Type.Literal("in_progress"),
				Type.Literal("completed"),
				Type.Literal("deleted"),
			]),
		),
		force: Type.Optional(Type.Boolean({ description: "Override ownership checks for claim/release" })),
		scope: Type.Optional(Type.Union([Type.Literal("completed"), Type.Literal("all")], { description: "Purge scope" })),
		confirm: Type.Optional(Type.Boolean({ description: "Must be true for purge" })),
	},
	{ additionalProperties: false },
)

function fail(action: TaskAction, error: string, details: Omit<Partial<TaskErrorDetails>, "action" | "error"> = {}) {
	const errorDetails: TaskErrorDetails = { action, error, ...details }
	return {
		content: [{ type: "text" as const, text: `Error: ${error}` }],
		isError: true as const,
		details: errorDetails,
	}
}

function parseTaskId(taskId: string | undefined): number | null {
	if (!taskId) return null
	const id = Number(taskId.trim())
	if (!Number.isFinite(id) || id <= 0) return null
	return id
}

function actionOf(input: TaskToolInput): TaskAction {
	return input.action
}

export function registerTaskTool(pi: ExtensionAPI) {
	pi.registerTool<typeof params, TaskToolDetails>({
		name: "task",
		label: "Task",
		description: "Manage tasks: list/get/create/update/claim/release/purge",
		promptSnippet: "Manage persistent tasks",
		parameters: params,
		async execute(_toolCallId, input: TaskToolInput, _signal, _onUpdate, ctx: ExtensionContext) {
			const db = getDb(ctx.cwd)
			const listId = getListId()
			const currentSessionId = ctx.sessionManager.getSessionId?.()

			switch (input.action) {
				case "list": {
					const { tasks, issues } = listTasksWithIssues(db, listId)
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

					const lines = tasks.map(
						(t) => `#${t.id} [${t.status}] ${t.subject}${ownerAssignedSuffix(t.owner, currentSessionId)}`,
					)
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
						return fail("get", `Task #${input.taskId} is unreadable. Details: ${message}`, { taskId: input.taskId })
					}
					if (!task) return fail("get", `Task #${input.taskId} not found`, { taskId: input.taskId })

					const lines = [
						`Task #${task.id}: ${task.subject}`,
						`Status: ${task.status}`,
						`Description: ${task.description}`,
					]
					if (task.owner)
						lines.push(`Owner: ${ownerDisplay(task.owner, currentSessionId, { includeCurrentSessionId: true })}`)

					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { action: "get", task, taskId: String(task.id), currentSessionId },
					}
				}

				case "create": {
					const subject = input.subject?.trim() ?? ""
					const description = input.description?.trim() ?? ""
					if (!subject) return fail("create", "subject is required")
					if (!description) return fail("create", "description is required")

					try {
						const task = await runWithListLock(ctx.cwd, listId, ctx, () =>
							createTask(db, listId, { subject, description }),
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
					const taskId = input.taskId ?? String(numId)
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
					if (input.status !== undefined && input.status !== existing.status) {
						if (input.status === "pending" || input.status === "in_progress" || input.status === "completed") {
							const status: TaskStatus = input.status
							fieldUpdates.status = status
							updatedFields.push("status")
						}
					}

					if (!updatedFields.length) {
						return {
							content: [{ type: "text", text: `No changes for task #${taskId}` }],
							details: { action: "update", taskId, updatedFields },
						}
					}

					try {
						await runWithListLock(ctx.cwd, listId, ctx, () => {
							const ok = updateTaskFields(db, listId, numId, fieldUpdates)
							if (!ok) throw new Error(`Task #${taskId} not found`)
						})
					} catch (error) {
						return fail("update", error instanceof Error ? error.message : String(error), { taskId })
					}

					return {
						content: [{ type: "text", text: `Updated task #${taskId}: ${updatedFields.join(", ")}` }],
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
							details: {
								action: "claim",
								taskId: input.taskId ?? String(numId),
								owner: currentSessionId,
								currentSessionId,
							},
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
							details: { action: "release", taskId: input.taskId ?? String(numId), owner: null, currentSessionId },
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
				default:
					return fail(actionOf(input), `unknown action: ${String(input.action)}`)
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

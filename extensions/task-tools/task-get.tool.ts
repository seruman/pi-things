import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { filterBlockedBy, getCompletedTaskIds, getDb, getListId, getTask } from "./db"
import { type GetDetails, renderGetCall, renderGetResult } from "./task-ui"

const params = Type.Object({
	taskId: Type.String({ description: "The ID of the task to retrieve" }),
	includeCompletedBlockers: Type.Optional(
		Type.Boolean({ description: "Include completed tasks in blockedBy (default: false)" }),
	),
})

export function registerTaskGetTool(pi: ExtensionAPI) {
	pi.registerTool<typeof params, GetDetails>({
		name: "task_get",
		label: "Get Task",
		description: "Get a task by ID from the task list",
		parameters: params,
		async execute(_toolCallId, p, _signal, _onUpdate, ctx: ExtensionContext) {
			const numId = Number(p.taskId.trim())
			if (!Number.isFinite(numId) || numId <= 0) {
				return {
					content: [{ type: "text", text: "Error: taskId must be a positive number" }],
					isError: true,
					details: { task: null, error: "invalid taskId" },
				}
			}

			const db = getDb(ctx.cwd)
			const listId = getListId()
			const task = getTask(db, listId, numId)

			if (!task) {
				return {
					content: [{ type: "text", text: `Task #${p.taskId} not found` }],
					isError: true,
					details: { task: null, error: "not found" },
				}
			}

			if (!p.includeCompletedBlockers) {
				const completedIds = getCompletedTaskIds(db, listId)
				task.blockedBy = filterBlockedBy(task.blockedBy, completedIds)
			}

			const lines = [`Task #${task.id}: ${task.subject}`, `Status: ${task.status}`, `Description: ${task.description}`]
			if (task.owner) lines.push(`Owner: ${task.owner}`)
			if (task.blockedBy.length) lines.push(`Blocked by: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`)
			if (task.blocks.length) lines.push(`Blocks: ${task.blocks.map((id) => `#${id}`).join(", ")}`)

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { task },
			}
		},
		renderCall(args, theme) {
			return renderGetCall(args, theme)
		},
		renderResult(result, options, theme) {
			return renderGetResult(result, options, theme)
		},
	})
}

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { filterBlockedBy, getCompletedTaskIds, getDb, getListId, listTasks } from "./db"
import { type ListDetails, renderListCall, renderListResult } from "./task-ui"

const params = Type.Object({
	includeCompletedBlockers: Type.Optional(
		Type.Boolean({ description: "Include completed tasks in blockedBy (default: false)" }),
	),
})

export function registerTaskListTool(pi: ExtensionAPI) {
	pi.registerTool<typeof params, ListDetails>({
		name: "task_list",
		label: "List Tasks",
		description: "List all tasks in the task list",
		parameters: params,
		async execute(_toolCallId, p, _signal, _onUpdate, ctx: ExtensionContext) {
			const db = getDb(ctx.cwd)
			const listId = getListId()
			const tasks = listTasks(db, listId)

			if (!p.includeCompletedBlockers) {
				const completedIds = getCompletedTaskIds(db, listId)
				for (const task of tasks) {
					task.blockedBy = filterBlockedBy(task.blockedBy, completedIds)
				}
			}

			const counts = {
				total: tasks.length,
				pending: tasks.filter((t) => t.status === "pending").length,
				inProgress: tasks.filter((t) => t.status === "in_progress").length,
				completed: tasks.filter((t) => t.status === "completed").length,
			}

			if (tasks.length === 0) {
				return {
					content: [{ type: "text", text: "No tasks" }],
					details: { tasks, counts },
				}
			}

			const lines = tasks.map((t) => {
				const blocked = t.blockedBy.length ? ` [blocked by ${t.blockedBy.map((id) => `#${id}`).join(", ")}]` : ""
				const owner = t.owner ? ` (${t.owner})` : ""
				return `#${t.id} [${t.status}] ${t.subject}${owner}${blocked}`
			})

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { tasks, counts },
			}
		},
		renderCall(args, theme) {
			return renderListCall(args, theme)
		},
		renderResult(result, options, theme) {
			return renderListResult(result, options, theme)
		},
	})
}

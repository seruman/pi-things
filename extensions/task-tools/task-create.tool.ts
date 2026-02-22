import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { createTask, getDb, getListId } from "./db"
import { type CreateDetails, renderCreateCall, renderCreateResult } from "./task-ui"

const params = Type.Object({
	subject: Type.String({ description: "Brief task title" }),
	description: Type.String({ description: "Detailed description of what needs to be done" }),
	activeForm: Type.Optional(
		Type.String({ description: 'Present continuous form for spinners (e.g. "Running tests")' }),
	),
	owner: Type.Optional(Type.String({ description: "Owner/assignee name" })),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arbitrary metadata" })),
})

export function registerTaskCreateTool(pi: ExtensionAPI) {
	pi.registerTool<typeof params, CreateDetails>({
		name: "task_create",
		label: "Create Task",
		description: "Create a new task in the task list",
		parameters: params,
		async execute(_toolCallId, p, _signal, _onUpdate, ctx: ExtensionContext) {
			const subject = p.subject.trim()
			const description = p.description.trim()
			if (!subject)
				return {
					content: [{ type: "text", text: "Error: subject is required" }],
					isError: true,
					details: { taskId: 0, subject: "" },
				}
			if (!description)
				return {
					content: [{ type: "text", text: "Error: description is required" }],
					isError: true,
					details: { taskId: 0, subject: "" },
				}

			const db = getDb(ctx.cwd)
			const listId = getListId()
			const task = createTask(db, listId, {
				subject,
				description,
				activeForm: p.activeForm,
				owner: p.owner,
				metadata: p.metadata,
			})

			return {
				content: [{ type: "text", text: `Task #${task.id} created: ${task.subject}` }],
				details: { taskId: task.id, subject: task.subject },
			}
		},
		renderCall(args, theme) {
			return renderCreateCall(args, theme)
		},
		renderResult(result, options, theme) {
			return renderCreateResult(result, options, theme)
		},
	})
}

import { StringEnum } from "@mariozechner/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { addDependency, deleteTask, getDb, getListId, getTask, taskExists, updateTaskFields } from "./db"
import { type UpdateDetails, renderUpdateCall, renderUpdateResult } from "./task-ui"
import type { TaskStatus } from "./types"

const params = Type.Object({
	taskId: Type.String({ description: "The ID of the task to update" }),
	subject: Type.Optional(Type.String({ description: "New subject" })),
	description: Type.Optional(Type.String({ description: "New description" })),
	activeForm: Type.Optional(Type.String({ description: "Present continuous form for spinners" })),
	owner: Type.Optional(Type.String({ description: "New owner" })),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
			description: "New status (or deleted to remove)",
		}),
	),
	addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
	addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), { description: "Metadata to merge (null value deletes key)" }),
	),
})

function fail(
	taskId: string,
	error: string,
): { content: { type: "text"; text: string }[]; isError: true; details: UpdateDetails } {
	return {
		content: [{ type: "text", text: `Error: ${error}` }],
		isError: true,
		details: { taskId, updatedFields: [], error },
	}
}

export function registerTaskUpdateTool(pi: ExtensionAPI) {
	pi.registerTool<typeof params, UpdateDetails>({
		name: "task_update",
		label: "Update Task",
		description: "Update a task: change fields, status, dependencies, or delete",
		parameters: params,
		async execute(_toolCallId, p, _signal, _onUpdate, ctx: ExtensionContext) {
			const taskId = p.taskId.trim()
			const numId = Number(taskId)
			if (!Number.isFinite(numId) || numId <= 0) return fail(taskId, "taskId must be a positive number")

			const db = getDb(ctx.cwd)
			const listId = getListId()
			const existing = getTask(db, listId, numId)
			if (!existing) return fail(taskId, `Task #${taskId} not found`)

			if (p.status === "deleted") {
				const ok = deleteTask(db, listId, numId)
				return {
					content: [{ type: "text", text: ok ? `Deleted task #${taskId}` : `Failed to delete task #${taskId}` }],
					details: {
						taskId,
						updatedFields: ok ? ["deleted"] : [],
						deleted: ok,
						statusChange: ok ? { from: existing.status, to: "deleted" } : undefined,
					},
				}
			}

			const updatedFields: string[] = []
			const fieldUpdates: Parameters<typeof updateTaskFields>[3] = {}

			if (p.subject !== undefined && p.subject !== existing.subject) {
				fieldUpdates.subject = p.subject
				updatedFields.push("subject")
			}
			if (p.description !== undefined && p.description !== existing.description) {
				fieldUpdates.description = p.description
				updatedFields.push("description")
			}
			if (p.activeForm !== undefined) {
				fieldUpdates.activeForm = p.activeForm || null
				updatedFields.push("activeForm")
			}
			if (p.owner !== undefined) {
				fieldUpdates.owner = p.owner || null
				updatedFields.push("owner")
			}
			if (p.status !== undefined && p.status !== existing.status) {
				fieldUpdates.status = p.status
				updatedFields.push("status")
			}

			if (p.metadata !== undefined) {
				const merged = { ...(existing.metadata ?? {}) }
				for (const [key, value] of Object.entries(p.metadata)) {
					if (value === null || value === undefined) {
						delete merged[key]
					} else {
						merged[key] = value
					}
				}
				fieldUpdates.metadata = Object.keys(merged).length > 0 ? merged : null
				updatedFields.push("metadata")
			}

			if (Object.keys(fieldUpdates).length > 0) {
				updateTaskFields(db, listId, numId, fieldUpdates)
			}

			if (p.addBlocks?.length) {
				for (const blockedIdStr of p.addBlocks) {
					const blockedId = Number(blockedIdStr)
					if (!Number.isFinite(blockedId) || blockedId <= 0)
						return fail(taskId, `Invalid dependency ID: ${blockedIdStr}`)
					if (blockedId === numId) return fail(taskId, "Task cannot block itself")
					if (!taskExists(db, listId, blockedId)) return fail(taskId, `Task #${blockedIdStr} not found`)
					addDependency(db, numId, blockedId)
				}
				updatedFields.push("blocks")
			}

			if (p.addBlockedBy?.length) {
				for (const blockerIdStr of p.addBlockedBy) {
					const blockerId = Number(blockerIdStr)
					if (!Number.isFinite(blockerId) || blockerId <= 0)
						return fail(taskId, `Invalid dependency ID: ${blockerIdStr}`)
					if (blockerId === numId) return fail(taskId, "Task cannot be blocked by itself")
					if (!taskExists(db, listId, blockerId)) return fail(taskId, `Task #${blockerIdStr} not found`)
					addDependency(db, blockerId, numId)
				}
				updatedFields.push("blockedBy")
			}

			const statusChange = fieldUpdates.status ? { from: existing.status, to: fieldUpdates.status } : undefined

			let text = `Updated task #${taskId}`
			if (updatedFields.length) text += `: ${updatedFields.join(", ")}`

			return {
				content: [{ type: "text", text }],
				details: { taskId, updatedFields, statusChange },
			}
		},
		renderCall(args, theme) {
			return renderUpdateCall(args, theme)
		},
		renderResult(result, options, theme) {
			return renderUpdateResult(result, options, theme)
		},
	})
}

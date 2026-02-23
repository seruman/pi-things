import type { ExtensionContext } from "@mariozechner/pi-coding-agent"
import { type TaskStore, getTask, getUnresolvedBlockers, runWithListLock, updateTaskFields } from "./db"

export async function claimTaskOwnership(options: {
	db: TaskStore
	cwd: string
	listId: string
	taskId: number
	sessionId: string
	force?: boolean
	ctx?: ExtensionContext
}): Promise<void> {
	await runWithListLock(options.cwd, options.listId, options.ctx, () => {
		const task = getTask(options.db, options.listId, options.taskId)
		if (!task) throw new Error(`Task #${options.taskId} not found`)
		if (task.status === "completed") throw new Error(`Task #${options.taskId} is completed`)
		if (task.owner && task.owner !== options.sessionId && !options.force) {
			throw new Error(`Task #${options.taskId} is owned by another session`)
		}
		const unresolved = getUnresolvedBlockers(options.db, options.listId, options.taskId)
		if (unresolved.length && !options.force) {
			throw new Error(`Task #${options.taskId} is blocked by ${unresolved.map((id) => `#${id}`).join(", ")}`)
		}
		updateTaskFields(options.db, options.listId, options.taskId, { owner: options.sessionId })
	})
}

export async function releaseTaskOwnership(options: {
	db: TaskStore
	cwd: string
	listId: string
	taskId: number
	sessionId: string
	force?: boolean
	ctx?: ExtensionContext
}): Promise<void> {
	await runWithListLock(options.cwd, options.listId, options.ctx, () => {
		const task = getTask(options.db, options.listId, options.taskId)
		if (!task) throw new Error(`Task #${options.taskId} not found`)
		if (!task.owner) return
		if (task.owner !== options.sessionId && !options.force) {
			throw new Error(`Task #${options.taskId} is owned by another session`)
		}
		updateTaskFields(options.db, options.listId, options.taskId, { owner: null })
	})
}

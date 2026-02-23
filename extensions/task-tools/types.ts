export type TaskStatus = "pending" | "in_progress" | "completed"
export type TaskUpdateStatus = TaskStatus | "deleted"
export type TaskAction = "list" | "get" | "create" | "update" | "claim" | "release" | "purge"

export interface Task {
	id: number
	listId: string
	subject: string
	description: string
	status: TaskStatus
	owner: string | null
	activeForm: string | null
	metadata: Record<string, unknown> | null
	createdAt: number
	updatedAt: number
	blocks: number[]
	blockedBy: number[]
}

export type TaskCounts = { total: number; pending: number; inProgress: number; completed: number }
export type TaskIssue = { file: string; error: string }

export type TaskToolInput = {
	action: TaskAction
	taskId?: string
	subject?: string
	description?: string
	activeForm?: string
	status?: TaskUpdateStatus
	addBlocks?: string[]
	addBlockedBy?: string[]
	metadata?: Record<string, unknown>
	includeCompletedBlockers?: boolean
	force?: boolean
	scope?: "completed" | "all"
	confirm?: boolean
}

export type TaskErrorDetails = {
	action: TaskAction
	error: string
	taskId?: string
	scope?: "completed" | "all"
}

export type TaskToolDetails =
	| TaskErrorDetails
	| { action: "list"; tasks: Task[]; counts: TaskCounts; currentSessionId?: string; issues?: TaskIssue[] }
	| { action: "get"; task: Task; taskId: string; currentSessionId?: string }
	| { action: "create"; task: Task; taskId: string }
	| {
			action: "update"
			taskId: string
			updatedFields?: string[]
			statusChange?: { from: string; to: string }
			deleted?: boolean
	  }
	| { action: "claim"; taskId: string; owner: string; currentSessionId?: string }
	| { action: "release"; taskId: string; owner: null; currentSessionId?: string }
	| { action: "purge"; scope: "completed" | "all"; deletedCount: number }

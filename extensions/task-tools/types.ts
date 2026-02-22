export type TaskStatus = "pending" | "in_progress" | "completed"
export type TaskUpdateStatus = TaskStatus | "deleted"

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

export interface TaskRow {
	id: number
	list_id: string
	subject: string
	description: string
	status: TaskStatus
	owner: string | null
	active_form: string | null
	metadata: string | null
	created_at: number
	updated_at: number
}

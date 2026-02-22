import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import type { Task, TaskRow, TaskStatus } from "./types"

let db: Database.Database | null = null
let currentDbPath: string | null = null

function parseMetadata(raw: string): Record<string, unknown> | null {
	const parsed: unknown = JSON.parse(raw)
	if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
		return parsed as Record<string, unknown>
	}
	return null
}

function getDbPath(cwd: string): string {
	const dir = path.join(cwd, ".pi")
	fs.mkdirSync(dir, { recursive: true })
	return path.join(dir, "tasks.db")
}

export function getDb(cwd: string): Database.Database {
	const dbPath = getDbPath(cwd)
	if (db && currentDbPath === dbPath) return db

	if (db) db.close()

	db = new Database(dbPath)
	currentDbPath = dbPath

	db.pragma("journal_mode = WAL")
	db.pragma("foreign_keys = ON")
	db.pragma("busy_timeout = 3000")

	db.exec(`
		CREATE TABLE IF NOT EXISTS tasks (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			list_id      TEXT NOT NULL,
			subject      TEXT NOT NULL,
			description  TEXT NOT NULL,
			status       TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed')),
			owner        TEXT,
			active_form  TEXT,
			metadata     TEXT,
			created_at   INTEGER NOT NULL,
			updated_at   INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS task_dependencies (
			blocker_id   INTEGER NOT NULL,
			blocked_id   INTEGER NOT NULL,
			PRIMARY KEY (blocker_id, blocked_id),
			FOREIGN KEY (blocker_id) REFERENCES tasks(id) ON DELETE CASCADE,
			FOREIGN KEY (blocked_id) REFERENCES tasks(id) ON DELETE CASCADE,
			CHECK (blocker_id != blocked_id)
		);

		CREATE INDEX IF NOT EXISTS idx_tasks_list_id ON tasks(list_id);
		CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
		CREATE INDEX IF NOT EXISTS idx_dep_blocker ON task_dependencies(blocker_id);
		CREATE INDEX IF NOT EXISTS idx_dep_blocked ON task_dependencies(blocked_id);
	`)

	return db
}

export function getListId(): string {
	return process.env.TASK_LIST_ID ?? "default"
}

function rowToTask(row: TaskRow, db: Database.Database): Task {
	const blocks = db
		.prepare<[number], { blocked_id: number }>("SELECT blocked_id FROM task_dependencies WHERE blocker_id = ?")
		.all(row.id)
		.map((r) => r.blocked_id)

	const blockedBy = db
		.prepare<[number], { blocker_id: number }>("SELECT blocker_id FROM task_dependencies WHERE blocked_id = ?")
		.all(row.id)
		.map((r) => r.blocker_id)

	return {
		id: row.id,
		listId: row.list_id,
		subject: row.subject,
		description: row.description,
		status: row.status,
		owner: row.owner,
		activeForm: row.active_form,
		metadata: row.metadata ? parseMetadata(row.metadata) : null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		blocks,
		blockedBy,
	}
}

export function createTask(
	db: Database.Database,
	listId: string,
	data: {
		subject: string
		description: string
		activeForm?: string
		owner?: string
		metadata?: Record<string, unknown>
	},
): Task {
	const now = Date.now()
	const result = db
		.prepare(
			`INSERT INTO tasks (list_id, subject, description, status, owner, active_form, metadata, created_at, updated_at)
			 VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
		)
		.run(
			listId,
			data.subject,
			data.description,
			data.owner ?? null,
			data.activeForm ?? null,
			data.metadata ? JSON.stringify(data.metadata) : null,
			now,
			now,
		)
	const task = getTask(db, listId, Number(result.lastInsertRowid))
	if (!task) throw new Error("Failed to read task after insert")
	return task
}

export function getTask(db: Database.Database, listId: string, taskId: number): Task | null {
	const row = db
		.prepare<[string, number], TaskRow>("SELECT * FROM tasks WHERE list_id = ? AND id = ?")
		.get(listId, taskId)
	if (!row) return null
	return rowToTask(row, db)
}

export function listTasks(db: Database.Database, listId: string): Task[] {
	const rows = db.prepare<[string], TaskRow>("SELECT * FROM tasks WHERE list_id = ? ORDER BY id ASC").all(listId)
	return rows.map((row) => rowToTask(row, db))
}

export function deleteTask(db: Database.Database, listId: string, taskId: number): boolean {
	const result = db.prepare("DELETE FROM tasks WHERE list_id = ? AND id = ?").run(listId, taskId)
	return result.changes > 0
}

export function updateTaskFields(
	db: Database.Database,
	listId: string,
	taskId: number,
	fields: Partial<{
		subject: string
		description: string
		activeForm: string | null
		owner: string | null
		status: TaskStatus
		metadata: Record<string, unknown> | null
	}>,
): boolean {
	const sets: string[] = []
	const values: unknown[] = []

	if (fields.subject !== undefined) {
		sets.push("subject = ?")
		values.push(fields.subject)
	}
	if (fields.description !== undefined) {
		sets.push("description = ?")
		values.push(fields.description)
	}
	if (fields.activeForm !== undefined) {
		sets.push("active_form = ?")
		values.push(fields.activeForm)
	}
	if (fields.owner !== undefined) {
		sets.push("owner = ?")
		values.push(fields.owner)
	}
	if (fields.status !== undefined) {
		sets.push("status = ?")
		values.push(fields.status)
	}
	if (fields.metadata !== undefined) {
		sets.push("metadata = ?")
		values.push(fields.metadata ? JSON.stringify(fields.metadata) : null)
	}

	if (sets.length === 0) return true

	sets.push("updated_at = ?")
	values.push(Date.now())
	values.push(listId, taskId)

	const result = db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE list_id = ? AND id = ?`).run(...values)
	return result.changes > 0
}

export function addDependency(db: Database.Database, blockerId: number, blockedId: number): void {
	db.prepare("INSERT OR IGNORE INTO task_dependencies (blocker_id, blocked_id) VALUES (?, ?)").run(blockerId, blockedId)
}

export function taskExists(db: Database.Database, listId: string, taskId: number): boolean {
	const row = db
		.prepare<[string, number], { id: number }>("SELECT id FROM tasks WHERE list_id = ? AND id = ?")
		.get(listId, taskId)
	return !!row
}

export function getCompletedTaskIds(db: Database.Database, listId: string): Set<number> {
	const rows = db
		.prepare<[string], { id: number }>("SELECT id FROM tasks WHERE list_id = ? AND status = 'completed'")
		.all(listId)
	return new Set(rows.map((r) => r.id))
}

export function filterBlockedBy(blockedBy: number[], completedIds: Set<number>): number[] {
	return blockedBy.filter((id) => !completedIds.has(id))
}

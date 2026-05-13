import fs from "node:fs"
import path from "node:path"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import YAML from "yaml"
import { z } from "zod"
import type { Task, TaskStatus } from "./types"

const TASKS_ROOT = path.join(".pi", "tasks")
const LOCK_FILE = ".lock"
const HIGH_WATERMARK_FILE = ".highwatermark"
const LOCK_TTL_MS = 30 * 60 * 1000

export type TaskStore = {
	cwd: string
}

export type TaskReadIssue = {
	file: string
	error: string
}

const taskStatusSchema = z.enum(["pending", "in_progress", "completed"])

const taskFrontMatterSchema = z
	.object({
		id: z.string().regex(/^\d+$/),
		subject: z.string(),
		description: z.string().optional(), // legacy fallback; body is the source of truth
		status: taskStatusSchema,
		owner: z.string().nullable().optional(),
		created_at: z.string(),
		updated_at: z.string(),
	})
	.passthrough()

type TaskFrontMatter = z.infer<typeof taskFrontMatterSchema>

const lockInfoSchema = z
	.object({
		pid: z.number(),
		created_at: z.string(),
		listId: z.string(),
		sessionId: z.string().nullable().optional(),
	})
	.strict()

type LockInfo = z.infer<typeof lockInfoSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function sanitizeListId(raw: string): string {
	const value = raw.trim() || "default"
	return value.replace(/[^a-zA-Z0-9_-]/g, "-")
}

function getListDir(cwd: string, listId: string): string {
	return path.join(cwd, TASKS_ROOT, sanitizeListId(listId))
}

function taskFilePath(cwd: string, listId: string, taskId: number): string {
	return path.join(getListDir(cwd, listId), `${taskId}.md`)
}

function lockFilePath(cwd: string, listId: string): string {
	return path.join(getListDir(cwd, listId), LOCK_FILE)
}

function highWatermarkPath(cwd: string, listId: string): string {
	return path.join(getListDir(cwd, listId), HIGH_WATERMARK_FILE)
}

function ensureListDir(cwd: string, listId: string): void {
	fs.mkdirSync(getListDir(cwd, listId), { recursive: true })
}

function parseTaskIdFromFilename(fileName: string): number | null {
	const match = fileName.match(/^(\d+)\.md$/)
	if (!match) return null
	const id = Number(match[1])
	return Number.isFinite(id) && id > 0 ? id : null
}

function parseMarkdownTask(content: string, fallbackId: number): Task {
	if (!content.startsWith("---\n")) throw new Error("missing YAML frontmatter")

	const end = content.indexOf("\n---\n", 4)
	if (end === -1) throw new Error("unterminated YAML frontmatter")

	const frontMatterText = content.slice(4, end)
	const body = content.slice(end + 5).trim()
	const yamlParsed = YAML.parse(frontMatterText)
	const result = taskFrontMatterSchema.safeParse(yamlParsed)
	if (!result.success) {
		throw new Error(
			`frontmatter validation failed: ${result.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ")}`,
		)
	}

	const fm = result.data
	const id = Number(fm.id)
	const createdAt = Number.isFinite(Date.parse(fm.created_at)) ? Date.parse(fm.created_at) : Date.now()
	const updatedAt = Number.isFinite(Date.parse(fm.updated_at)) ? Date.parse(fm.updated_at) : createdAt
	const description = body || fm.description || ""

	return {
		id: Number.isFinite(id) && id > 0 ? id : fallbackId,
		listId: "",
		subject: fm.subject,
		description,
		status: fm.status,
		owner: typeof fm.owner === "string" && fm.owner.length > 0 ? fm.owner : null,
		createdAt,
		updatedAt,
	}
}

function serializeMarkdownTask(task: Task): string {
	const frontMatter: TaskFrontMatter = {
		id: String(task.id),
		subject: task.subject,
		status: task.status,
		owner: task.owner ?? null,
		created_at: new Date(task.createdAt).toISOString(),
		updated_at: new Date(task.updatedAt).toISOString(),
	}

	const yaml = YAML.stringify(frontMatter).trimEnd()
	const body = task.description.trim()
	return `---\n${yaml}\n---\n\n${body}\n`
}

function atomicWrite(filePath: string, content: string): void {
	const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
	fs.writeFileSync(tempPath, content, "utf8")
	fs.renameSync(tempPath, filePath)
}

function readTask(cwd: string, listId: string, taskId: number): Task | null {
	const filePath = taskFilePath(cwd, listId, taskId)
	if (!fs.existsSync(filePath)) return null
	const content = fs.readFileSync(filePath, "utf8")
	const task = parseMarkdownTask(content, taskId)
	task.listId = listId
	return task
}

function writeTask(cwd: string, listId: string, task: Task): void {
	const filePath = taskFilePath(cwd, listId, task.id)
	atomicWrite(filePath, serializeMarkdownTask(task))
}

function readAllTaskIds(cwd: string, listId: string): number[] {
	const dir = getListDir(cwd, listId)
	if (!fs.existsSync(dir)) return []
	const ids: number[] = []
	for (const entry of fs.readdirSync(dir)) {
		const id = parseTaskIdFromFilename(entry)
		if (id !== null) ids.push(id)
	}
	ids.sort((a, b) => a - b)
	return ids
}

function readHighWatermark(cwd: string, listId: string): number {
	const filePath = highWatermarkPath(cwd, listId)
	if (!fs.existsSync(filePath)) return 0
	const value = Number(fs.readFileSync(filePath, "utf8").trim())
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function writeHighWatermark(cwd: string, listId: string, value: number): void {
	atomicWrite(highWatermarkPath(cwd, listId), `${Math.max(0, Math.floor(value))}\n`)
}

function nextTaskId(cwd: string, listId: string): number {
	const ids = readAllTaskIds(cwd, listId)
	const maxFromFiles = ids.length ? ids[ids.length - 1] : 0
	const high = readHighWatermark(cwd, listId)
	const next = Math.max(maxFromFiles, high) + 1
	writeHighWatermark(cwd, listId, next)
	return next
}

function getErrnoCode(error: unknown): string | undefined {
	if (!isRecord(error)) return undefined
	const code = error.code
	return typeof code === "string" ? code : undefined
}

function readLockInfo(lockPath: string): LockInfo | null {
	try {
		const raw = fs.readFileSync(lockPath, "utf8")
		const parsed: unknown = JSON.parse(raw)
		const result = lockInfoSchema.safeParse(parsed)
		if (!result.success) return null
		return result.data
	} catch {
		return null
	}
}

export async function runWithListLock<T>(
	cwd: string,
	listId: string,
	ctx: ExtensionContext | undefined,
	fn: () => T,
): Promise<T> {
	ensureListDir(cwd, listId)
	const lockPath = lockFilePath(cwd, listId)
	const now = Date.now()
	const sessionId = ctx?.sessionManager.getSessionId?.() ?? null

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = fs.openSync(lockPath, "wx")
			const info: LockInfo = {
				pid: process.pid,
				created_at: new Date(now).toISOString(),
				listId,
				sessionId,
			}
			fs.writeFileSync(fd, JSON.stringify(info, null, 2), "utf8")
			fs.closeSync(fd)

			try {
				return fn()
			} finally {
				try {
					fs.unlinkSync(lockPath)
				} catch {
					// ignore
				}
			}
		} catch (error) {
			const code = getErrnoCode(error)
			if (code !== "EEXIST") throw error

			const stats = fs.statSync(lockPath, { throwIfNoEntry: false })
			const age = stats ? now - stats.mtimeMs : LOCK_TTL_MS + 1
			const info = readLockInfo(lockPath)

			if (age <= LOCK_TTL_MS) {
				if (attempt === 0) {
					await new Promise((resolve) => setTimeout(resolve, 120))
					continue
				}
				const owner = info?.sessionId ? ` (session ${info.sessionId})` : info?.pid ? ` (pid ${info.pid})` : ""
				throw new Error(`Task list is locked${owner}; try again later`)
			}

			if (ctx?.hasUI) {
				const owner = info?.sessionId ? `session ${info.sessionId}` : info?.pid ? `pid ${info.pid}` : "unknown owner"
				const ok = await ctx.ui.confirm("Task list locked", `Stale lock detected (${owner}). Steal lock?`)
				if (!ok) throw new Error("Task list remains locked")
			}

			try {
				fs.unlinkSync(lockPath)
			} catch (unlinkError) {
				const unlinkCode = getErrnoCode(unlinkError)
				if (unlinkCode !== "ENOENT") {
					const owner = info?.sessionId ? ` by session ${info.sessionId}` : info?.pid ? ` by pid ${info.pid}` : ""
					throw new Error(`Task list lock appears stale${owner}, but could not be removed`)
				}
			}
		}
	}

	throw new Error("Failed to acquire task list lock")
}

export function getDb(cwd: string): TaskStore {
	return { cwd }
}

export function getDbIfExists(cwd: string): TaskStore | null {
	const listId = getListId()
	const dir = getListDir(cwd, listId)
	if (!fs.existsSync(dir)) return null
	const hasTasks = fs.readdirSync(dir).some((entry) => entry.endsWith(".md"))
	return hasTasks ? { cwd } : null
}

export function getListId(): string {
	return process.env.TASK_LIST_ID ?? "default"
}

export function createTask(db: TaskStore, listId: string, data: { subject: string; description: string }): Task {
	const id = nextTaskId(db.cwd, listId)
	const now = Date.now()
	const task: Task = {
		id,
		listId,
		subject: data.subject,
		description: data.description,
		status: "pending",
		owner: null,
		createdAt: now,
		updatedAt: now,
	}
	writeTask(db.cwd, listId, task)
	return task
}

export function getTask(db: TaskStore, listId: string, taskId: number): Task | null {
	return readTask(db.cwd, listId, taskId)
}

export function listTasksWithIssues(db: TaskStore, listId: string): { tasks: Task[]; issues: TaskReadIssue[] } {
	const ids = readAllTaskIds(db.cwd, listId)
	const tasks: Task[] = []
	const issues: TaskReadIssue[] = []

	for (const id of ids) {
		const file = `${id}.md`
		try {
			const task = readTask(db.cwd, listId, id)
			if (task) tasks.push({ ...task, listId })
		} catch (error) {
			issues.push({ file, error: error instanceof Error ? error.message : String(error) })
		}
	}

	return { tasks, issues }
}

export function listTasks(db: TaskStore, listId: string): Task[] {
	return listTasksWithIssues(db, listId).tasks
}

export function deleteTask(db: TaskStore, listId: string, taskId: number): boolean {
	const existing = readTask(db.cwd, listId, taskId)
	if (!existing) return false

	const filePath = taskFilePath(db.cwd, listId, taskId)
	if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
	return true
}

export function updateTaskFields(
	db: TaskStore,
	listId: string,
	taskId: number,
	fields: Partial<{ subject: string; description: string; owner: string | null; status: TaskStatus }>,
): boolean {
	const task = readTask(db.cwd, listId, taskId)
	if (!task) return false

	if (fields.subject !== undefined) task.subject = fields.subject
	if (fields.description !== undefined) task.description = fields.description
	if (fields.owner !== undefined) task.owner = fields.owner
	if (fields.status !== undefined) task.status = fields.status
	task.updatedAt = Date.now()
	writeTask(db.cwd, listId, task)
	return true
}

export function purgeTasks(db: TaskStore, listId: string, scope: "completed" | "all"): number {
	const tasks = listTasks(db, listId)
	const targets = scope === "all" ? tasks : tasks.filter((t) => t.status === "completed")
	for (const task of targets) deleteTask(db, listId, task.id)
	return targets.length
}

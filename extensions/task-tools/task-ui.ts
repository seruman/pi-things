import { type AgentToolResult, type Theme, type ToolRenderResultOptions, keyHint } from "@mariozechner/pi-coding-agent"
import { type Component, Text } from "@mariozechner/pi-tui"
import type { Task } from "./types"

function statusIcon(status: string, theme: Theme): string {
	switch (status) {
		case "completed":
			return theme.fg("success", "✓")
		case "in_progress":
			return theme.fg("warning", "▶")
		default:
			return theme.fg("dim", "○")
	}
}

function statusColor(status: string, theme: Theme, text: string): string {
	switch (status) {
		case "completed":
			return theme.fg("success", text)
		case "in_progress":
			return theme.fg("warning", text)
		default:
			return theme.fg("muted", text)
	}
}

function blockedBadge(blockedBy: number[], theme: Theme): string {
	if (!blockedBy.length) return ""
	return theme.fg("error", ` (blocked by ${blockedBy.map((id) => `#${id}`).join(", ")})`)
}

function ownerBadge(owner: string | null, theme: Theme): string {
	if (!owner) return ""
	return theme.fg("dim", ` (${owner})`)
}

function taskLine(task: Task, theme: Theme, filteredBlockedBy?: number[]): string {
	const icon = statusIcon(task.status, theme)
	const id = theme.fg("accent", `#${task.id}`)
	const subject = statusColor(task.status, theme, task.subject)
	const blocked = blockedBadge(filteredBlockedBy ?? task.blockedBy, theme)
	const owner = ownerBadge(task.owner, theme)
	return `${icon} ${id} ${subject}${owner}${blocked}`
}

export interface CreateDetails {
	taskId: number
	subject: string
}

export function renderCreateCall(args: { subject?: string }, theme: Theme): Component {
	let text = theme.fg("toolTitle", theme.bold("task_create "))
	text += theme.fg("muted", args.subject ?? "")
	return new Text(text, 0, 0)
}

export function renderCreateResult(
	result: AgentToolResult<CreateDetails>,
	_options: ToolRenderResultOptions,
	theme: Theme,
): Component {
	const d = result.details
	const text = `${theme.fg("success", "✓ ")}Task ${theme.fg("accent", `#${d.taskId}`)} created: ${theme.fg("muted", d.subject)}`
	return new Text(text, 0, 0)
}

export interface UpdateDetails {
	taskId: string
	updatedFields: string[]
	statusChange?: { from: string; to: string }
	deleted?: boolean
	error?: string
}

export function renderUpdateCall(args: { taskId?: string; status?: string }, theme: Theme): Component {
	let text = theme.fg("toolTitle", theme.bold("task_update "))
	if (args.taskId) text += theme.fg("accent", `#${args.taskId}`)
	if (args.status) text += ` → ${theme.fg("muted", args.status)}`
	return new Text(text, 0, 0)
}

export function renderUpdateResult(
	result: AgentToolResult<UpdateDetails>,
	_options: ToolRenderResultOptions,
	theme: Theme,
): Component {
	const d = result.details
	if (d.error) return new Text(theme.fg("error", `Error: ${d.error}`), 0, 0)
	if (d.deleted) return new Text(theme.fg("success", "✓ ") + theme.fg("muted", `Deleted task #${d.taskId}`), 0, 0)

	if (d.statusChange?.to === "in_progress") {
		return new Text(`${theme.fg("warning", "▶ ")}Now working on ${theme.fg("accent", `#${d.taskId}`)}`, 0, 0)
	}
	if (d.statusChange?.to === "completed") {
		return new Text(`${theme.fg("success", "✓ ")}Completed ${theme.fg("accent", `#${d.taskId}`)}`, 0, 0)
	}

	const fields = d.updatedFields.join(", ")
	return new Text(
		`${theme.fg("success", "✓ ")}Updated ${theme.fg("accent", `#${d.taskId}`)}: ${theme.fg("muted", fields)}`,
		0,
		0,
	)
}

export interface GetDetails {
	task: Task | null
	error?: string
}

export function renderGetCall(args: { taskId?: string }, theme: Theme): Component {
	let text = theme.fg("toolTitle", theme.bold("task_get "))
	if (args.taskId) text += theme.fg("accent", `#${args.taskId}`)
	return new Text(text, 0, 0)
}

export function renderGetResult(
	result: AgentToolResult<GetDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Component {
	const d = result.details
	if (d.error) return new Text(theme.fg("error", `Error: ${d.error}`), 0, 0)
	if (!d.task) return new Text(theme.fg("error", "Task not found"), 0, 0)

	const t = d.task
	if (!options.expanded) {
		const text = `${statusIcon(t.status, theme)} ${theme.fg("accent", `#${t.id}`)} ${statusColor(t.status, theme, t.subject)} ${theme.fg("dim", `[${t.status}]`)}`
		return new Text(text, 0, 0)
	}

	const lines: string[] = []
	lines.push(
		`${statusIcon(t.status, theme)} ${theme.fg("accent", theme.bold(`Task #${t.id}`))} ${statusColor(t.status, theme, t.subject)}`,
	)
	lines.push(`  ${theme.fg("dim", "Status:")} ${statusColor(t.status, theme, t.status)}`)
	lines.push(`  ${theme.fg("dim", "Description:")} ${theme.fg("muted", t.description)}`)
	if (t.owner) lines.push(`  ${theme.fg("dim", "Owner:")} ${theme.fg("muted", t.owner)}`)
	if (t.blockedBy.length)
		lines.push(`  ${theme.fg("dim", "Blocked by:")} ${t.blockedBy.map((id) => theme.fg("error", `#${id}`)).join(", ")}`)
	if (t.blocks.length)
		lines.push(`  ${theme.fg("dim", "Blocks:")} ${t.blocks.map((id) => theme.fg("accent", `#${id}`)).join(", ")}`)

	return new Text(lines.join("\n"), 0, 0)
}

export interface ListDetails {
	tasks: Task[]
	counts: { total: number; pending: number; inProgress: number; completed: number }
}

export function renderListCall(_args: Record<string, unknown>, theme: Theme): Component {
	return new Text(theme.fg("toolTitle", theme.bold("task_list")), 0, 0)
}

export function renderListResult(
	result: AgentToolResult<ListDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Component {
	const d = result.details
	const c = d.counts

	if (c.total === 0) return new Text(theme.fg("dim", "No tasks"), 0, 0)

	const summary = [
		theme.fg("muted", `${c.total} total`),
		c.inProgress > 0 ? theme.fg("warning", `${c.inProgress} in progress`) : null,
		c.pending > 0 ? theme.fg("dim", `${c.pending} pending`) : null,
		c.completed > 0 ? theme.fg("success", `${c.completed} done`) : null,
	]
		.filter(Boolean)
		.join(theme.fg("dim", " · "))

	if (!options.expanded) {
		return new Text(`Tasks: ${summary} ${theme.fg("dim", `(${keyHint("expandTools", "to expand")})`)}`, 0, 0)
	}

	const lines: string[] = [`Tasks: ${summary}`, ""]

	const inProgress = d.tasks.filter((t) => t.status === "in_progress")
	const pending = d.tasks.filter((t) => t.status === "pending")
	const completed = d.tasks.filter((t) => t.status === "completed")

	if (inProgress.length) {
		lines.push(theme.fg("warning", theme.bold("In Progress")))
		for (const t of inProgress) lines.push(`  ${taskLine(t, theme)}`)
		lines.push("")
	}

	if (pending.length) {
		lines.push(theme.fg("muted", theme.bold("Pending")))
		for (const t of pending) lines.push(`  ${taskLine(t, theme)}`)
		lines.push("")
	}

	if (completed.length) {
		lines.push(theme.fg("success", theme.bold("Completed")))
		for (const t of completed) lines.push(`  ${taskLine(t, theme)}`)
	}

	return new Text(lines.join("\n"), 0, 0)
}

import { type AgentToolResult, type Theme, type ToolRenderResultOptions, keyHint } from "@mariozechner/pi-coding-agent"
import { type Component, Text } from "@mariozechner/pi-tui"
import { ownerAssignedSuffix, ownerDisplay } from "./owner-format"
import type { Task, TaskToolDetails, TaskToolInput } from "./types"

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
	return ` ${theme.fg("error", "(blocked by ")}${blockedBy
		.map((id) => theme.fg("accent", `#${id}`))
		.join(theme.fg("error", ", "))}${theme.fg("error", ")")}`
}

function taskLine(task: Task, theme: Theme, currentSessionId?: string): string {
	return `${statusIcon(task.status, theme)} ${theme.fg("accent", `#${task.id}`)} ${statusColor(task.status, theme, task.subject)}${theme.fg("dim", ownerAssignedSuffix(task.owner, currentSessionId))}${blockedBadge(task.blockedBy, theme)}`
}

export function renderTaskCall(args: TaskToolInput, theme: Theme): Component {
	let text = theme.fg("toolTitle", theme.bold("task ")) + theme.fg("muted", args.action)
	if (args.taskId) text += ` ${theme.fg("accent", `#${args.taskId}`)}`
	if (args.subject) text += ` ${theme.fg("dim", `"${args.subject}"`)}`
	return new Text(text, 0, 0)
}

export function renderTaskResult(
	result: AgentToolResult<TaskToolDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Component {
	const d = result.details
	if ("error" in d) return new Text(theme.fg("error", `Error (${d.action}): ${d.error}`), 0, 0)

	switch (d.action) {
		case "create":
			return new Text(
				`${theme.fg("success", "✓ ")}Created ${theme.fg("accent", `#${d.task.id}`)} ${theme.fg("muted", d.task.subject)}`,
				0,
				0,
			)
		case "update": {
			if (d.deleted) return new Text(`${theme.fg("success", "✓ ")}Deleted ${theme.fg("accent", `#${d.taskId}`)}`, 0, 0)
			if (d.statusChange?.to === "in_progress")
				return new Text(`${theme.fg("warning", "▶ ")}Now working on ${theme.fg("accent", `#${d.taskId}`)}`, 0, 0)
			if (d.statusChange?.to === "completed")
				return new Text(`${theme.fg("success", "✓ ")}Completed ${theme.fg("accent", `#${d.taskId}`)}`, 0, 0)
			return new Text(
				`${theme.fg("success", "✓ ")}Updated ${theme.fg("accent", `#${d.taskId}`)}: ${theme.fg("muted", d.updatedFields?.join(", ") ?? "updated")}`,
				0,
				0,
			)
		}
		case "claim":
			return new Text(
				`${theme.fg("success", "✓ ")}Claimed ${theme.fg("accent", `#${d.taskId}`)} ${theme.fg("dim", `(owner: ${ownerDisplay(d.owner, d.currentSessionId, { includeCurrentSessionId: true })})`)}`,
				0,
				0,
			)
		case "release":
			return new Text(`${theme.fg("success", "✓ ")}Released ${theme.fg("accent", `#${d.taskId}`)}`, 0, 0)
		case "purge":
			return new Text(
				`${theme.fg("success", "✓ ")}Purged ${theme.fg("accent", String(d.deletedCount))} task(s) ${theme.fg("muted", `(${d.scope})`)}`,
				0,
				0,
			)
		case "get": {
			const t = d.task
			if (!options.expanded) {
				return new Text(
					`${statusIcon(t.status, theme)} ${theme.fg("accent", `#${t.id}`)} ${statusColor(t.status, theme, t.subject)} ${theme.fg("dim", `[${t.status}]`)}`,
					0,
					0,
				)
			}
			const lines = [
				`${statusIcon(t.status, theme)} ${theme.fg("accent", theme.bold(`Task #${t.id}`))} ${statusColor(t.status, theme, t.subject)}`,
				`  ${theme.fg("dim", "Status:")} ${statusColor(t.status, theme, t.status)}`,
			]
			if (t.activeForm) lines.push(`  ${theme.fg("dim", "Activity:")} ${theme.fg("warning", t.activeForm)}`)
			lines.push(`  ${theme.fg("dim", "Description:")} ${theme.fg("muted", t.description)}`)
			if (t.owner)
				lines.push(
					`  ${theme.fg("dim", "Owner:")} ${theme.fg("muted", ownerDisplay(t.owner, d.currentSessionId, { includeCurrentSessionId: true }))}`,
				)
			if (t.blockedBy.length)
				lines.push(
					`  ${theme.fg("dim", "Blocked by:")} ${t.blockedBy.map((id) => theme.fg("error", `#${id}`)).join(", ")}`,
				)
			if (t.blocks.length)
				lines.push(`  ${theme.fg("dim", "Blocks:")} ${t.blocks.map((id) => theme.fg("accent", `#${id}`)).join(", ")}`)
			return new Text(lines.join("\n"), 0, 0)
		}
		case "list": {
			const c = d.counts
			if (c.total === 0) {
				const warn = d.issues?.length ? `\n${theme.fg("warning", `Skipped ${d.issues.length} broken file(s)`)}` : ""
				return new Text(theme.fg("dim", "No tasks") + warn, 0, 0)
			}
			const summary = [
				theme.fg("muted", `${c.total} total`),
				c.inProgress > 0 ? theme.fg("warning", `${c.inProgress} in progress`) : null,
				c.pending > 0 ? theme.fg("dim", `${c.pending} pending`) : null,
				c.completed > 0 ? theme.fg("success", `${c.completed} done`) : null,
			]
				.filter((part): part is string => Boolean(part))
				.join(theme.fg("dim", " · "))

			if (!options.expanded) {
				const assigned = d.currentSessionId ? d.tasks.filter((t) => t.owner === d.currentSessionId) : []
				const assignedText = assigned.length
					? `${theme.fg("dim", " · assigned ")}${assigned.map((t) => theme.fg("accent", `#${t.id}`)).join(theme.fg("dim", ", "))}`
					: ""
				const warn = d.issues?.length ? ` ${theme.fg("warning", `· ${d.issues.length} broken`)}` : ""
				return new Text(
					`Tasks: ${summary}${assignedText}${warn} ${theme.fg("dim", `(${keyHint("expandTools", "to expand")})`)}`,
					0,
					0,
				)
			}

			const lines: string[] = []
			const title = `${c.total} tasks (${c.completed} done, ${c.inProgress} in progress, ${c.pending} open)`
			lines.push(theme.fg("muted", title))
			lines.push("")

			for (const t of [...d.tasks].sort((a, b) => {
				const rank = (s: string) => (s === "in_progress" ? 0 : s === "pending" ? 1 : 2)
				const r = rank(a.status) - rank(b.status)
				if (r !== 0) return r
				return a.id - b.id
			})) {
				const owner = t.owner ? ` ${theme.fg("dim", `(@${ownerDisplay(t.owner, d.currentSessionId)})`)}` : ""
				const blocked = t.blockedBy.length
					? `${theme.fg("dim", " › blocked by ")}${t.blockedBy.map((id) => theme.fg("accent", `#${id}`)).join(theme.fg("dim", ", "))}`
					: ""

				if (t.status === "completed") {
					lines.push(`${theme.fg("success", "✔")} ${theme.fg("muted", t.subject)}${owner}`)
				} else if (t.status === "in_progress") {
					lines.push(`${theme.fg("warning", "◼")} ${theme.fg("warning", t.subject)}${owner}`)
					if (t.activeForm) lines.push(`  ${theme.fg("warning", t.activeForm)}…`)
				} else {
					lines.push(`${theme.fg("dim", "◻")} ${theme.fg("muted", t.subject)}${owner}${blocked}`)
				}
			}

			if (d.issues?.length) {
				lines.push("")
				lines.push(theme.fg("warning", `Skipped ${d.issues.length} broken task file(s)`))
			}

			return new Text(lines.join("\n"), 0, 0)
		}
	}
}

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent"
import { type Component, Text, matchesKey, truncateToWidth } from "@mariozechner/pi-tui"
import { filterBlockedBy, getCompletedTaskIds, getDb, getListId, listTasks } from "./db"
import { registerTaskCreateTool } from "./task-create.tool"
import { registerTaskGetTool } from "./task-get.tool"
import { registerTaskListTool } from "./task-list.tool"
import { registerTaskUpdateTool } from "./task-update.tool"
import type { Task } from "./types"

const WIDGET_ID = "task-tools"

function loadTasks(ctx: ExtensionContext): Task[] {
	try {
		const db = getDb(ctx.cwd)
		const listId = getListId()
		const tasks = listTasks(db, listId)
		const completedIds = getCompletedTaskIds(db, listId)
		for (const t of tasks) t.blockedBy = filterBlockedBy(t.blockedBy, completedIds)
		return tasks
	} catch {
		return []
	}
}

function widgetLine(tasks: Task[], theme: Theme): string {
	if (!tasks.length) return theme.fg("dim", "Tasks: none")

	const total = tasks.length
	const inProgress = tasks.filter((t) => t.status === "in_progress")
	const pending = tasks.filter((t) => t.status === "pending").length
	const completed = tasks.filter((t) => t.status === "completed").length

	const parts: string[] = [theme.fg("muted", `Tasks: ${total}`)]
	if (inProgress.length) {
		const names = inProgress.map((t) => `#${t.id} ${t.subject}`).join(", ")
		parts.push(theme.fg("warning", `▶ ${names}`))
	}
	if (pending) parts.push(theme.fg("dim", `${pending} pending`))
	if (completed) parts.push(theme.fg("success", `${completed} done`))

	return parts.join(theme.fg("dim", " · "))
}

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

class TaskListComponent implements Component {
	private tasks: Task[]
	private theme: Theme
	private onClose: () => void
	private selected = 0
	private cachedWidth?: number
	private cachedLines?: string[]

	constructor(tasks: Task[], theme: Theme, onClose: () => void) {
		this.tasks = tasks
		this.theme = theme
		this.onClose = onClose
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.onClose()
			return
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (this.selected > 0) {
				this.selected--
				this.invalidate()
			}
			return
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			if (this.selected < this.tasks.length - 1) {
				this.selected++
				this.invalidate()
			}
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines

		const th = this.theme
		const lines: string[] = [""]

		const title = th.fg("accent", " Tasks ")
		lines.push(
			truncateToWidth(
				`${th.fg("borderMuted", "───")}${title}${th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)))}`,
				width,
			),
		)
		lines.push("")

		if (!this.tasks.length) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No tasks.")}`, width))
		} else {
			for (let idx = 0; idx < this.tasks.length; idx++) {
				const t = this.tasks[idx]
				const icon = statusIcon(t.status, th)
				const id = th.fg("accent", `#${t.id}`)
				const subjectColor = t.status === "completed" ? "dim" : t.status === "in_progress" ? "warning" : "muted"
				const subject = th.fg(subjectColor, t.subject)
				const blocked = t.blockedBy.length
					? th.fg("error", ` (blocked by ${t.blockedBy.map((b) => `#${b}`).join(", ")})`)
					: ""
				const owner = t.owner ? th.fg("dim", ` (${t.owner})`) : ""
				const pointer = idx === this.selected ? th.fg("accent", "> ") : "  "

				lines.push(truncateToWidth(`  ${pointer}${icon} ${id} ${subject}${owner}${blocked}`, width))
			}
		}

		lines.push("")
		lines.push(truncateToWidth(`  ${th.fg("dim", "j/k navigate · q/esc close")}`, width))
		lines.push("")

		this.cachedWidth = width
		this.cachedLines = lines
		return lines
	}

	invalidate(): void {
		this.cachedWidth = undefined
		this.cachedLines = undefined
	}
}

export default function (pi: ExtensionAPI) {
	let widgetVisible = true

	registerTaskCreateTool(pi)
	registerTaskUpdateTool(pi)
	registerTaskGetTool(pi)
	registerTaskListTool(pi)

	function updateWidget(ctx: ExtensionContext) {
		if (!widgetVisible || !ctx.hasUI) return
		const tasks = loadTasks(ctx)
		if (!tasks.length) {
			ctx.ui.setWidget(WIDGET_ID, undefined)
			return
		}
		ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => ({
			render: () => [widgetLine(tasks, theme)],
			invalidate() {},
		}))
	}

	function clearWidget(ctx: ExtensionContext) {
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined)
	}

	pi.on("session_start", async (_event, ctx) => updateWidget(ctx))
	pi.on("session_switch", async (_event, ctx) => updateWidget(ctx))

	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName.startsWith("task_")) updateWidget(ctx)
	})

	pi.registerShortcut("ctrl+shift+t", {
		description: "Toggle task widget",
		handler: async (ctx) => {
			widgetVisible = !widgetVisible
			if (widgetVisible) {
				updateWidget(ctx)
			} else {
				clearWidget(ctx)
			}
		},
	})

	pi.registerCommand("tasks", {
		description: "Show all tasks",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/tasks requires interactive mode", "error")
				return
			}

			const tasks = loadTasks(ctx)

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const component = new TaskListComponent(tasks, theme, () => done())
				return {
					render: (w: number) => component.render(w),
					invalidate: () => component.invalidate(),
					handleInput: (data: string) => {
						component.handleInput(data)
						tui.requestRender()
					},
				}
			})
		},
	})
}

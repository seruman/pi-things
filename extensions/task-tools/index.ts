import type { ExtensionAPI, ExtensionContext, KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent"
import { type Component, matchesKey, truncateToWidth } from "@mariozechner/pi-tui"
import { getDbIfExists, getListId, listTasksWithIssues } from "./db"
import { ownerAssignedSuffix, ownerDisplay } from "./owner-format"
import { registerTaskTool } from "./task.tool"
import type { Task } from "./types"

const WIDGET_ID = "task-tools"

function loadTasks(ctx: ExtensionContext): { tasks: Task[]; issues: Array<{ file: string; error: string }> } {
	try {
		const db = getDbIfExists(ctx.cwd)
		if (!db) return { tasks: [], issues: [] }
		const listId = getListId()
		const { tasks, issues } = listTasksWithIssues(db, listId)
		return { tasks, issues }
	} catch (error) {
		return {
			tasks: [],
			issues: [{ file: "(task list)", error: error instanceof Error ? error.message : String(error) }],
		}
	}
}

function widgetLine(tasks: Task[], theme: Theme, sessionId?: string): string {
	if (!tasks.length) return theme.fg("dim", "Tasks: none")

	const total = tasks.length
	const myInProgress = sessionId
		? tasks.filter((t) => t.status === "in_progress" && t.owner === sessionId)
		: tasks.filter((t) => t.status === "in_progress")
	const otherInProgress = sessionId ? tasks.filter((t) => t.status === "in_progress" && t.owner !== sessionId) : []
	const pending = tasks.filter((t) => t.status === "pending").length
	const completed = tasks.filter((t) => t.status === "completed").length
	const assigned = sessionId ? tasks.filter((t) => t.owner === sessionId) : []

	const parts: string[] = [theme.fg("muted", `Tasks: ${total}`)]
	if (myInProgress.length) {
		const names = myInProgress.map((t) => `#${t.id} ${t.subject}`).join(", ")
		parts.push(theme.fg("warning", `▶ ${names}`))
	}
	if (otherInProgress.length) parts.push(theme.fg("dim", `${otherInProgress.length} active elsewhere`))
	if (pending) parts.push(theme.fg("dim", `${pending} pending`))
	if (completed) parts.push(theme.fg("success", `${completed} done`))
	if (assigned.length)
		parts.push(
			`${theme.fg("dim", "assigned ")}${assigned.map((t) => theme.fg("accent", `#${t.id}`)).join(theme.fg("dim", ", "))}`,
		)

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
	private keybindings: KeybindingsManager
	private onClose: () => void
	private onWork: (task: Task) => void
	private onClarify: (task: Task) => void
	private sessionId?: string
	private selected = 0
	private mode: "list" | "details" = "list"
	private cachedWidth?: number
	private cachedLines?: string[]

	constructor(
		tasks: Task[],
		theme: Theme,
		keybindings: KeybindingsManager,
		onClose: () => void,
		onWork: (task: Task) => void,
		onClarify: (task: Task) => void,
		sessionId?: string,
	) {
		this.tasks = tasks
		this.theme = theme
		this.keybindings = keybindings
		this.onClose = onClose
		this.onWork = onWork
		this.onClarify = onClarify
		this.sessionId = sessionId
	}

	private currentTask(): Task | null {
		return this.tasks[this.selected] ?? null
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "q")) {
			if (this.mode === "details") {
				this.mode = "list"
				this.invalidate()
			} else {
				this.onClose()
			}
			return
		}

		if (this.mode === "details") {
			if (matchesKey(data, "b") || matchesKey(data, "left") || matchesKey(data, "h")) {
				this.mode = "list"
				this.invalidate()
				return
			}
			if (matchesKey(data, "w")) {
				const task = this.currentTask()
				if (task) this.onWork(task)
				return
			}
			if (matchesKey(data, "c")) {
				const task = this.currentTask()
				if (task) this.onClarify(task)
				return
			}
			return
		}

		if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) {
			if (this.selected > 0) {
				this.selected--
				this.invalidate()
			}
			return
		}
		if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) {
			if (this.selected < this.tasks.length - 1) {
				this.selected++
				this.invalidate()
			}
			return
		}

		if ((this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, "o")) && this.tasks.length) {
			this.mode = "details"
			this.invalidate()
			return
		}
		if (matchesKey(data, "w")) {
			const task = this.currentTask()
			if (task) this.onWork(task)
			return
		}
		if (matchesKey(data, "c")) {
			const task = this.currentTask()
			if (task) this.onClarify(task)
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines
		const lines = this.mode === "details" ? this.renderDetails(width) : this.renderList(width)
		this.cachedWidth = width
		this.cachedLines = lines
		return lines
	}

	private renderList(width: number): string[] {
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
				const owner = th.fg("dim", ownerAssignedSuffix(t.owner, this.sessionId))
				const pointer = idx === this.selected ? th.fg("accent", "> ") : "  "

				lines.push(truncateToWidth(`  ${pointer}${icon} ${id} ${subject}${owner}`, width))
			}
		}

		lines.push("")
		lines.push(
			truncateToWidth(`  ${th.fg("dim", "j/k navigate · enter/o details · w work · c clarify · q/esc close")}`, width),
		)
		lines.push("")
		return lines
	}

	private renderDetails(width: number): string[] {
		const th = this.theme
		const lines: string[] = [""]
		const task = this.tasks[this.selected]

		const titleText = task ? ` Tasks / #${task.id} ` : " Tasks / ? "
		const title = th.fg("accent", titleText)
		lines.push(
			truncateToWidth(
				`${th.fg("borderMuted", "───")}${title}${th.fg("borderMuted", "─".repeat(Math.max(0, width - titleText.length - 6)))}`,
				width,
			),
		)
		lines.push("")

		if (!task) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No selected task.")}`, width))
		} else {
			lines.push(truncateToWidth(`  ${th.bold("Subject:")} ${task.subject || "-"}`, width))
			lines.push(truncateToWidth(`  ${th.bold("Status:")} ${task.status}`, width))
			const ownerText = ownerDisplay(task.owner, this.sessionId, { none: "-", includeCurrentSessionId: true })
			lines.push(truncateToWidth(`  ${th.bold("Owner:")} ${ownerText}`, width))
			lines.push("")
			lines.push(truncateToWidth(`  ${th.bold("Description:")}`, width))
			for (const line of task.description.split("\n")) {
				lines.push(truncateToWidth(`  ${line}`, width))
			}
		}

		lines.push("")
		lines.push(truncateToWidth(`  ${th.fg("dim", "w work · c clarify · b/esc back · q close")}`, width))
		lines.push("")
		return lines
	}

	invalidate(): void {
		this.cachedWidth = undefined
		this.cachedLines = undefined
	}
}

export default function (pi: ExtensionAPI) {
	let widgetVisible = true

	registerTaskTool(pi)

	function updateWidget(ctx: ExtensionContext) {
		if (!widgetVisible || !ctx.hasUI) return
		const initial = loadTasks(ctx)
		if (!initial.tasks.length) {
			ctx.ui.setWidget(WIDGET_ID, undefined)
			return
		}
		const sessionId = ctx.sessionManager.getSessionId?.()
		ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => ({
			render: (width: number) => {
				const { tasks } = loadTasks(ctx)
				if (!tasks.length) return [truncateToWidth(theme.fg("dim", "Tasks: none"), width)]
				return [truncateToWidth(widgetLine(tasks, theme, sessionId), width)]
			},
			invalidate() {},
		}))
	}

	function clearWidget(ctx: ExtensionContext) {
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined)
	}

	pi.on("session_start", async (_event, ctx) => updateWidget(ctx))

	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName === "task") updateWidget(ctx)
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
			const { tasks, issues } = loadTasks(ctx)
			if (!ctx.hasUI) {
				if (!tasks.length) {
					console.log("No tasks")
				} else {
					for (const task of tasks) {
						const sessionId = ctx.sessionManager.getSessionId?.()
						const owner = ownerAssignedSuffix(task.owner, sessionId)
						console.log(`#${task.id} [${task.status}] ${task.subject}${owner}`)
					}
				}
				if (issues.length) {
					console.log("")
					console.log(`Warning: skipped ${issues.length} broken task file(s)`)
					for (const issue of issues.slice(0, 5)) console.log(`- ${issue.file}: ${issue.error}`)
					if (issues.length > 5) console.log(`- ...and ${issues.length - 5} more`)
				}
				return
			}

			if (issues.length) ctx.ui.notify(`Skipped ${issues.length} broken task file(s)`, "warning")

			const sessionId = ctx.sessionManager.getSessionId?.()
			let nextPrompt: string | null = null
			let requestRender: (() => void) | undefined
			await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
				requestRender = () => tui.requestRender()
				const toWorkPrompt = (task: Task) => `work on task #${task.id} "${task.subject}"`
				const toClarifyPrompt = (task: Task) =>
					`clarify task #${task.id} "${task.subject}". Refine scope, acceptance criteria, dependencies, and concrete next actions.`

				const component = new TaskListComponent(
					tasks,
					theme,
					keybindings,
					() => done(),
					(task) => {
						nextPrompt = toWorkPrompt(task)
						done()
					},
					(task) => {
						nextPrompt = toClarifyPrompt(task)
						done()
					},
					sessionId,
				)
				return {
					render: (w: number) => component.render(w),
					invalidate: () => component.invalidate(),
					handleInput: (data: string) => {
						component.handleInput(data)
						tui.requestRender()
					},
				}
			})
			if (nextPrompt) {
				ctx.ui.setEditorText(nextPrompt)
				requestRender?.()
			}
		},
	})
}

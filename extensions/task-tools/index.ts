import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent"
import { type Component, Text, matchesKey, truncateToWidth } from "@mariozechner/pi-tui"
import { filterBlockedBy, getCompletedTaskIds, getDbIfExists, getListId, listTasksWithIssues } from "./db"
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
		const completedIds = getCompletedTaskIds(db, listId)
		for (const t of tasks) t.blockedBy = filterBlockedBy(t.blockedBy, completedIds)
		return { tasks, issues }
	} catch (error) {
		return {
			tasks: [],
			issues: [{ file: "(task list)", error: error instanceof Error ? error.message : String(error) }],
		}
	}
}

function widgetLine(tasks: Task[], theme: Theme, sessionId?: string): string {
	const openTasks = tasks.filter((t) => t.status !== "completed")
	if (!openTasks.length) return theme.fg("dim", "Tasks: none active")

	const myInProgress = sessionId
		? openTasks.filter((t) => t.status === "in_progress" && t.owner === sessionId)
		: openTasks.filter((t) => t.status === "in_progress")
	const otherInProgress = sessionId ? openTasks.filter((t) => t.status === "in_progress" && t.owner !== sessionId) : []
	const pending = openTasks.filter((t) => t.status === "pending").length
	const assigned = sessionId ? openTasks.filter((t) => t.owner === sessionId) : []

	const parts: string[] = [theme.fg("muted", `Tasks: ${openTasks.length} active`)]
	if (myInProgress.length) {
		const names = myInProgress
			.map((t) => {
				const label = t.activeForm || `#${t.id} ${t.subject}`
				return label
			})
			.join(", ")
		parts.push(theme.fg("warning", `▶ ${names}`))
	}
	if (otherInProgress.length) parts.push(theme.fg("dim", `${otherInProgress.length} active elsewhere`))
	if (pending) parts.push(theme.fg("dim", `${pending} pending`))
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

function sortTasksForDisplay(tasks: Task[]): Task[] {
	const rank = (status: Task["status"]) => {
		switch (status) {
			case "in_progress":
				return 0
			case "pending":
				return 1
			case "completed":
				return 2
		}
	}
	return [...tasks].sort((a, b) => {
		const r = rank(a.status) - rank(b.status)
		if (r !== 0) return r
		return a.id - b.id
	})
}

class TaskListComponent implements Component {
	private tasks: Task[]
	private theme: Theme
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
		onClose: () => void,
		onWork: (task: Task) => void,
		onClarify: (task: Task) => void,
		sessionId?: string,
	) {
		this.tasks = tasks
		this.theme = theme
		this.onClose = onClose
		this.onWork = onWork
		this.onClarify = onClarify
		this.sessionId = sessionId
	}

	private currentTask(): Task | null {
		return this.tasks[this.selected] ?? null
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.onClose()
			return
		}

		if (this.mode === "details") {
			if (matchesKey(data, "escape") || matchesKey(data, "b") || matchesKey(data, "left") || matchesKey(data, "h")) {
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

		if (matchesKey(data, "escape")) {
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
			return
		}

		if ((matchesKey(data, "enter") || matchesKey(data, "o")) && this.tasks.length) {
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
				const activeForm = t.status === "in_progress" && t.activeForm ? ` ${th.fg("warning", `(${t.activeForm})`)}` : ""
				const blocked = t.blockedBy.length
					? ` ${th.fg("error", "(blocked by ")}${t.blockedBy.map((b) => th.fg("accent", `#${b}`)).join(th.fg("error", ", "))}${th.fg("error", ")")}`
					: ""
				const owner = th.fg("dim", ownerAssignedSuffix(t.owner, this.sessionId))
				const pointer = idx === this.selected ? th.fg("accent", "> ") : "  "

				lines.push(truncateToWidth(`  ${pointer}${icon} ${id} ${subject}${activeForm}${owner}${blocked}`, width))
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
			if (task.activeForm)
				lines.push(truncateToWidth(`  ${th.bold("Activity:")} ${th.fg("warning", task.activeForm)}`, width))
			const ownerText = ownerDisplay(task.owner, this.sessionId, { none: "-", includeCurrentSessionId: true })
			lines.push(truncateToWidth(`  ${th.bold("Owner:")} ${ownerText}`, width))
			lines.push(
				truncateToWidth(
					`  ${th.bold("Blocked by:")} ${task.blockedBy.length ? task.blockedBy.map((id) => `#${id}`).join(", ") : "-"}`,
					width,
				),
			)
			lines.push(
				truncateToWidth(
					`  ${th.bold("Blocks:")} ${task.blocks.length ? task.blocks.map((id) => `#${id}`).join(", ") : "-"}`,
					width,
				),
			)
			if (task.metadata && Object.keys(task.metadata).length) {
				lines.push(truncateToWidth(`  ${th.bold("Metadata:")} ${JSON.stringify(task.metadata)}`, width))
			}
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
			render: () => {
				const { tasks } = loadTasks(ctx)
				if (!tasks.length) return [theme.fg("dim", "Tasks: none")]
				return [widgetLine(tasks, theme, sessionId)]
			},
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
			const { tasks, issues } = loadTasks(ctx)
			const sortedTasks = sortTasksForDisplay(tasks)
			if (!ctx.hasUI) {
				if (!sortedTasks.length) {
					console.log("No tasks")
				} else {
					const inProgress = sortedTasks.filter((t) => t.status === "in_progress").length
					const completed = sortedTasks.filter((t) => t.status === "completed").length
					const pending = sortedTasks.filter((t) => t.status === "pending").length
					console.log(`${sortedTasks.length} tasks (${completed} done, ${inProgress} in progress, ${pending} open)`)

					const sessionId = ctx.sessionManager.getSessionId?.()
					for (const task of sortedTasks) {
						const owner = task.owner ? ` (@${ownerDisplay(task.owner, sessionId)})` : ""
						if (task.status === "completed") {
							console.log(`✔ ${task.subject}${owner}`)
						} else if (task.status === "in_progress") {
							console.log(`◼ ${task.subject}${owner}`)
							if (task.activeForm) console.log(`  ${task.activeForm}…`)
						} else {
							const blocked = task.blockedBy.length
								? ` › blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")}`
								: ""
							console.log(`◻ ${task.subject}${owner}${blocked}`)
						}
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
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				requestRender = () => tui.requestRender()
				const toWorkPrompt = (task: Task) => `work on task #${task.id} "${task.subject}"`
				const toClarifyPrompt = (task: Task) =>
					`clarify task #${task.id} "${task.subject}". Refine scope, acceptance criteria, dependencies, and concrete next actions.`

				const component = new TaskListComponent(
					sortedTasks,
					theme,
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

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent"
import { SubagentRegistry } from "./registry"
import { registerSubagentTool } from "./subagent.tool"
import type { SubagentEntry } from "./types"

const WIDGET_ID = "subagent-tools"

export default function (pi: ExtensionAPI) {
	// Recursion prevention: don't register if we're already a subagent
	const depth = Number(process.env.PI_SUBAGENT_DEPTH) || 0
	if (depth >= 1) return

	const registry = new SubagentRegistry()

	// Track which background agents have been notified about
	const notifiedAgents = new Set<string>()

	registerSubagentTool(pi, registry)

	pi.on("session_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId?.()
		if (sessionId) registry.setSessionId(sessionId)

		// Widget: live subagent status above editor
		ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => ({
			render: () => renderWidget(registry, theme),
			invalidate() {},
		}))
	})

	// Inject completion notifications for background agents before each agent turn.
	// This is the pi equivalent of Claude's <agent-notification> XML injection —
	// we can't inject mid-conversation, so we batch notifications and inject
	// them when the model is about to process the next user prompt.
	pi.on("before_agent_start", (_event, _ctx) => {
		const completed = registry.all().filter((e) => e.status !== "running" && !notifiedAgents.has(e.agentId))

		if (!completed.length) return

		const lines: string[] = []
		for (const entry of completed) {
			notifiedAgents.add(entry.agentId)
			const task = entry.taskId ? ` (task #${entry.taskId})` : ""
			const dur = formatDuration(registry.getDuration(entry))
			const exit = entry.exitCode !== undefined ? `, exit ${entry.exitCode}` : ""
			lines.push(
				`Subagent ${entry.agentId}${task} ${entry.status} (${dur}${exit}). Output file: ${entry.outputFile ?? "n/a"}`,
			)
		}

		return {
			message: {
				customType: "subagent-notification",
				content: lines.join("\n"),
				display: true,
			},
		}
	})

	pi.on("session_shutdown", async () => {
		registry.cleanupFiles()
	})
}

function renderWidget(registry: SubagentRegistry, theme: Theme): string[] {
	const running = registry.running()

	// Only show widget when agents are running
	if (!running.length) return []

	const lines: string[] = []

	for (const entry of running) {
		const id = theme.fg("accent", entry.agentId)
		const task = entry.taskId ? ` ${theme.fg("muted", `#${entry.taskId}`)}` : ""
		const dur = formatDuration(registry.getDuration(entry))
		const model = entry.model ? ` ${theme.fg("dim", entry.model)}` : ""
		const pid = theme.fg("dim", `pid:${entry.pid}`)

		lines.push(`${theme.fg("warning", "▶")} ${id}${task} ${dur}${model}  ${pid}`)
	}

	return lines
}

function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000)
	if (s < 60) return `${s}s`
	const m = Math.floor(s / 60)
	const rem = s % 60
	return `${m}m ${rem}s`
}

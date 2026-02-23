import type { Theme } from "@mariozechner/pi-coding-agent"
import { Text } from "@mariozechner/pi-tui"
import type { SubagentToolResult } from "./types"

export function renderSubagentCall(args: Record<string, unknown>, theme: Theme): Text {
	const action = String(args.action ?? "subagent")
	const parts = [`subagent ${action}`]

	if (args.agentId) parts.push(String(args.agentId))
	if (args.taskId) parts.push(`#${args.taskId}`)
	if (args.background) parts.push("(background)")
	if (args.model) parts.push(`model:${args.model}`)

	return new Text(theme.fg("toolTitle", parts.join(" ")), 0, 0)
}

export function renderSubagentResult(
	result: { details?: SubagentToolResult; isError?: boolean },
	options: { expanded: boolean },
	theme: Theme,
): Text {
	const d = result.details
	if (!d) return new Text(theme.fg("dim", "subagent (no details)"), 0, 0)

	if ("error" in d && !("output" in d)) {
		return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0)
	}

	switch (d.action) {
		case "spawn": {
			if ("status" in d && d.status === "running") {
				// background spawn
				return new Text(
					`${theme.fg("success", "⚡")} Spawned ${theme.fg("accent", d.agentId)} pid:${theme.fg("dim", String(d.pid))}${d.taskId ? ` → #${d.taskId}` : ""}`,
					0,
					0,
				)
			}
			// blocking spawn completed
			const icon = d.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗")
			const dur = formatDuration(d.durationMs)
			if (!options.expanded) {
				return new Text(
					`${icon} ${theme.fg("accent", d.agentId)} pid:${theme.fg("dim", String(d.pid))} ${dur}${d.taskId ? ` #${d.taskId}` : ""}`,
					0,
					0,
				)
			}
			const lines = [
				`${icon} Agent ${theme.fg("accent", d.agentId)} pid:${theme.fg("dim", String(d.pid))} exited ${d.exitCode} (${dur})`,
			]
			if (d.output) {
				lines.push("")
				lines.push(theme.fg("dim", "─── output ───"))
				lines.push(d.output.slice(-2000))
			}
			if (d.error) {
				lines.push("")
				lines.push(theme.fg("error", "─── stderr ───"))
				lines.push(d.error.slice(-1000))
			}
			return new Text(lines.join("\n"), 0, 0)
		}

		case "status": {
			const icon = statusIcon(d.status, theme)
			const dur = d.durationMs ? ` ${formatDuration(d.durationMs)}` : ""
			return new Text(
				`${icon} ${theme.fg("accent", d.agentId)} pid:${theme.fg("dim", String(d.pid))} [${d.status}]${dur}`,
				0,
				0,
			)
		}

		case "output": {
			const icon = statusIcon(d.status, theme)
			if (!options.expanded) {
				const preview = d.output ? (d.output.split("\n")[0]?.slice(0, 80) ?? "") : "(no output)"
				return new Text(
					`${icon} ${theme.fg("accent", d.agentId)} pid:${theme.fg("dim", String(d.pid))} ${theme.fg("dim", preview)}`,
					0,
					0,
				)
			}
			const lines = [
				`${icon} Agent ${theme.fg("accent", d.agentId)} pid:${theme.fg("dim", String(d.pid))} [${d.status}]${d.ready ? " (done)" : " (running)"}`,
			]
			if (d.output) {
				lines.push("")
				lines.push(d.output.slice(-2000))
			}
			return new Text(lines.join("\n"), 0, 0)
		}

		case "stop": {
			return new Text(
				`${theme.fg("warning", "⏹")} Stopped ${theme.fg("accent", d.agentId)} pid:${theme.fg("dim", String(d.pid))}`,
				0,
				0,
			)
		}

		case "list": {
			if (!d.agents.length) return new Text(theme.fg("dim", "No subagents"), 0, 0)
			const lines = d.agents.map((a) => {
				const icon = statusIcon(a.status, theme)
				const task = a.taskId ? ` #${a.taskId}` : ""
				const dur = a.durationMs ? ` ${formatDuration(a.durationMs)}` : ""
				const model = a.model ? ` ${theme.fg("dim", a.model)}` : ""
				return `${icon} ${theme.fg("accent", a.agentId)}${task}${dur}${model} pid:${theme.fg("dim", String(a.pid))}`
			})
			return new Text(lines.join("\n"), 0, 0)
		}
	}

	return new Text(theme.fg("dim", "subagent result"), 0, 0)
}

function statusIcon(status: string, theme: Theme): string {
	switch (status) {
		case "running":
			return theme.fg("warning", "▶")
		case "completed":
			return theme.fg("success", "✓")
		case "failed":
			return theme.fg("error", "✗")
		case "timeout":
			return theme.fg("error", "⏱")
		case "stopped":
			return theme.fg("dim", "⏹")
		default:
			return theme.fg("dim", "?")
	}
}

function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000)
	if (s < 60) return `${s}s`
	const m = Math.floor(s / 60)
	const rem = s % 60
	return `${m}m ${rem}s`
}

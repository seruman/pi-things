import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent"
import { Text } from "@mariozechner/pi-tui"
import type { FetchDetails } from "./fetch-lib"

function firstText(result: AgentToolResult<FetchDetails>): string {
	for (const c of result.content) {
		if (c.type === "text") return c.text ?? ""
	}
	return ""
}

export function renderFetchResult(
	result: AgentToolResult<FetchDetails>,
	opts: ToolRenderResultOptions,
	theme: Theme,
): Text {
	const d = result.details
	if (opts.isPartial) {
		const p = Math.max(0, Math.min(1, d.progress ?? 0))
		const filled = Math.floor(p * 10)
		const bar = "█".repeat(filled) + "░".repeat(10 - filled)
		return new Text(theme.fg("accent", `[${bar}] ${d.phase || "fetching"}`), 0, 0)
	}

	if (d.error) return new Text(theme.fg("error", `Error: ${d.error}`), 0, 0)

	const mode = d.mode ? theme.fg("muted", ` · ${d.mode}`) : ""
	let status = `${theme.fg("success", d.title || "Content")}${mode}${theme.fg("muted", ` (${d.totalChars ?? 0} chars)`)}`
	if (typeof d.durationMs === "number") status += theme.fg("muted", ` | ${(d.durationMs / 1000).toFixed(1)}s`)
	if (!opts.expanded) return new Text(status, 0, 0)

	const text = firstText(result).trim()
	const preview = text.length > 1200 ? `${text.slice(0, 1200)}...` : text
	return new Text(`${status}\n${theme.fg("dim", preview)}`, 0, 0)
}

export function renderFetchCall(args: Record<string, unknown>, theme: Theme, toolName = "web_fetch"): Text {
	const url = typeof args.url === "string" ? args.url : ""
	const urls = Array.isArray(args.urls) ? args.urls.filter((u): u is string => typeof u === "string") : []
	const format = typeof args.format === "string" ? args.format : "auto"

	if (!url && urls.length === 0) {
		return new Text(theme.fg("toolTitle", theme.bold(`${toolName} `)) + theme.fg("error", "(no URL)"), 0, 0)
	}

	if (urls.length > 0) {
		const header = theme.fg("toolTitle", theme.bold(`${toolName} `)) + theme.fg("muted", `(${format})`)
		const lines = [header]
		for (const u of urls) {
			const display = u.length > 120 ? `${u.slice(0, 117)}...` : u
			lines.push(theme.fg("accent", display))
		}
		return new Text(lines.join("\n"), 0, 0)
	}

	const display = url.length > 80 ? `${url.slice(0, 77)}...` : url
	return new Text(
		theme.fg("toolTitle", theme.bold(`${toolName} `)) + theme.fg("accent", display) + theme.fg("muted", ` (${format})`),
		0,
		0,
	)
}

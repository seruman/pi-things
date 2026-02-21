import {
	type AgentToolResult,
	getMarkdownTheme,
	keyHint,
	type Theme,
	type ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent"
import { type Component, Markdown, Text } from "@mariozechner/pi-tui"
import { Type } from "@sinclair/typebox"

export type ProgressDetails = {
	phase?: string
	progress?: number
	label?: string
	attempt?: number
	maxRetries?: number
	reason?: string
	summary?: string
	statusCode?: number
	error?: string
	provider?: string
	query?: string
	durationMs?: number
}

export const searchParams = Type.Object({
	query: Type.String({ description: "The search query" }),
	providers: Type.Optional(
		Type.Array(Type.Union([Type.Literal("openai"), Type.Literal("gemini")]), {
			minItems: 1,
			description: 'Provider fallback order (default: ["gemini", "openai"])',
		}),
	),
	live: Type.Optional(Type.Boolean({ description: "Use live web access when provider supports it (default: true)" })),
	debug: Type.Optional(Type.Boolean({ description: "Include debug details in output" })),
})

function asErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	return String(error)
}

export function normalizeError(error: unknown): { message: string; statusCode?: number } {
	const message = asErrorMessage(error).trim()
	const match = message.match(/API error\s*\((\d{3})\)/i) ?? message.match(/\b(\d{3})\b/)
	const statusCode = match ? Number(match[1]) : undefined
	return { message, statusCode: Number.isFinite(statusCode) ? statusCode : undefined }
}

function firstMeaningfulLine(text: string): string {
	const line = text
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("[") && l !== "---")
	return line ?? text.trim()
}

export function summarizeSearchResult(text: string): string {
	const line = firstMeaningfulLine(text).replace(/\*\*/g, "")
	const clipped = line.length > 90 ? `${line.slice(0, 87)}...` : line
	return clipped || "Search completed"
}

function progressBar(progress: number | undefined, width = 10): string {
	const p = typeof progress === "number" ? Math.max(0, Math.min(1, progress)) : 0
	const filled = Math.floor(p * width)
	return "█".repeat(filled) + "░".repeat(width - filled)
}

function firstTextContent(result: AgentToolResult<ProgressDetails>): string {
	for (const block of result.content) {
		if (block.type === "text") return block.text?.trim() ?? ""
	}
	return ""
}

export function renderToolResult(
	result: AgentToolResult<ProgressDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Component {
	const details = result.details

	if (options.isPartial) {
		const phase = details.phase || "working"
		const providerText = details.provider
			? theme.italic(theme.fg("accent", details.provider))
			: theme.fg("muted", "auto")
		const query = (details.query || "").trim()
		const clippedQuery = query.length > 140 ? `${query.slice(0, 137)}...` : query

		const bar = progressBar(details.progress, 10)
		let state = phase
		if (phase === "retrying" && details.attempt && details.maxRetries) {
			const why = details.reason ? ` · ${details.reason}` : ""
			state = `retry ${details.attempt}/${details.maxRetries}${why}`
		} else if (phase === "streaming") {
			state = "streaming"
		}

		const lines = [providerText]
		if (clippedQuery) lines.push(theme.fg("dim", clippedQuery))
		lines.push(theme.fg("accent", `[${bar}] ${state}`))
		return new Text(lines.join("\n"), 0, 0)
	}

	if (details.error) {
		const code = details.statusCode ? ` (${details.statusCode})` : ""
		const head = details.summary || "search failed"
		return new Text(`${theme.fg("error", theme.bold(`✗ ${head}${code}`))}\n${theme.fg("dim", details.error)}`, 0, 0)
	}

	const text = firstTextContent(result) || "search completed"

	if (!options.expanded) {
		const query = (details.query || "").trim()
		const clippedQuery = query.length > 120 ? `${query.slice(0, 117)}...` : query
		const metaParts: string[] = []
		if (typeof details.durationMs === "number") metaParts.push(`${(details.durationMs / 1000).toFixed(1)}s`)
		const provider = details.provider ? ` · ${details.provider}` : ""

		const lines = [`${theme.fg("success", theme.bold("✓ done"))}${theme.fg("muted", provider)}`]
		if (clippedQuery) lines.push(theme.fg("dim", clippedQuery))
		if (metaParts.length) lines.push(theme.fg("dim", metaParts.join(" · ")))
		lines.push(theme.fg("muted", keyHint("expandTools", "to expand")))
		return new Text(lines.join("\n"), 0, 0)
	}

	const provider = details.provider ? ` · ${details.provider}` : ""
	const duration = typeof details.durationMs === "number" ? `${(details.durationMs / 1000).toFixed(1)}s` : undefined
	const query = (details.query || "").trim()

	const headerLines = [`**✓ done${provider}**`]
	if (query) headerLines.push(`Query: ${query}`)
	if (duration) headerLines.push(`Duration: ${duration}`)

	const markdown = `${headerLines.join("\n\n")}\n\n---\n\n${text}`
	return new Markdown(markdown, 0, 0, getMarkdownTheme())
}

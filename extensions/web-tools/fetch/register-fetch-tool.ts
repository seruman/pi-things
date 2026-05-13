import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { type FetchDetails, type FetchFormat, type FetchMode, fetchParams } from "./fetch-lib"
import { renderFetchCall, renderFetchResult } from "./fetch-ui"

type FetchExecutor = (
	url: string,
	format: FetchFormat,
	signal: AbortSignal | undefined,
	timeoutMs: number,
) => Promise<{ url: string; title: string; content: string; error: string | null }>

const MAX_TOTAL_OUTPUT_CHARS = 150_000

function createAbortError(): Error {
	return new DOMException("aborted", "AbortError")
}

function formatFetchBlock(result: {
	url: string
	title: string
	content: string
	error: string | null
	truncated: boolean
	originalChars: number
}): string {
	const lines: string[] = [`URL: ${result.url}`]
	if (result.error) {
		lines.push(`Error: ${result.error}`)
		return lines.join("\n")
	}

	lines.push(`Title: ${result.title}`)
	if (result.truncated) lines.push(`Truncated: yes (${result.originalChars} -> ${result.content.length} chars)`)
	lines.push("Content:")
	lines.push(result.content)
	return lines.join("\n").trimEnd()
}

export function registerFetchTool(
	pi: ExtensionAPI,
	config: {
		name: string
		label: string
		description: string
		mode: FetchMode
		executeFetch: FetchExecutor
	},
) {
	pi.registerTool<typeof fetchParams, FetchDetails>({
		name: config.name,
		label: config.label,
		description: config.description,
		promptSnippet:
			config.label === "Fetch (Rendered)"
				? "Fetch URL content through browser rendering"
				: "Fetch URL content with regular HTTP",
		parameters: fetchParams,
		async execute(_toolCallId, params, signal, onUpdate, _ctx: ExtensionContext) {
			if (signal?.aborted) throw createAbortError()

			const url = params.url.trim()
			if (!url) {
				return {
					content: [{ type: "text", text: "Error: url is required" }],
					isError: true,
					details: { error: "url is required", mode: config.mode },
				}
			}

			const format = params.format ?? "auto"
			const timeoutMs = params.timeoutMs ?? 30_000
			const perUrlMaxChars = params.perUrlMaxChars ?? 3_000

			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${url}...` }],
				details: { phase: "fetch", progress: 0.1, mode: config.mode, urlCount: 1, fetchedCount: 0 },
			})

			const startedAt = Date.now()
			let fetched: Awaited<ReturnType<FetchExecutor>>
			try {
				fetched = await config.executeFetch(url, format, signal, timeoutMs)
				if (signal?.aborted) throw createAbortError()
			} catch (error) {
				if ((error instanceof Error && error.name === "AbortError") || signal?.aborted) throw createAbortError()
				const message = error instanceof Error ? error.message : String(error)
				return {
					content: [{ type: "text", text: `Error: ${message}` }],
					isError: true,
					details: { error: message, mode: config.mode, durationMs: Date.now() - startedAt, urlCount: 1 },
				}
			}

			const originalChars = fetched.content.length
			const truncated = !fetched.error && originalChars > perUrlMaxChars
			const content = truncated ? fetched.content.slice(0, perUrlMaxChars) : fetched.content
			const result = {
				url: fetched.url || url,
				title: fetched.title || url,
				content,
				error: fetched.error,
				truncated,
				originalChars,
			}

			const rawOutput = formatFetchBlock(result)
			const aggregateTruncated = rawOutput.length > MAX_TOTAL_OUTPUT_CHARS
			const output = aggregateTruncated
				? `${rawOutput.slice(0, MAX_TOTAL_OUTPUT_CHARS)}\n\n[Output truncated: aggregate limit reached]`
				: rawOutput

			const durationMs = Date.now() - startedAt
			return {
				content: [{ type: "text", text: output }],
				isError: Boolean(result.error),
				details: {
					mode: config.mode,
					title: result.error ? "fetch failed" : result.title,
					totalChars: result.content.length,
					truncated: result.truncated || aggregateTruncated,
					durationMs,
					urlCount: 1,
					fetchedCount: result.error ? 0 : 1,
					error: result.error || undefined,
				},
			}
		},
		renderCall(args, theme) {
			return renderFetchCall(args, theme, config.name)
		},
		renderResult(result, opts, theme) {
			return renderFetchResult(result, opts, theme)
		},
	})
}

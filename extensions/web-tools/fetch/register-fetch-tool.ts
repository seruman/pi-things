import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { type FetchDetails, type FetchFormat, type FetchMode, fetchParams } from "./fetch-lib"
import { renderFetchCall, renderFetchResult } from "./fetch-ui"

type FetchExecutor = (
	url: string,
	format: FetchFormat,
	signal: AbortSignal | undefined,
	timeoutMs: number,
) => Promise<{ url: string; title: string; content: string; error: string | null }>

type FetchRecord = {
	url: string
	title: string
	content: string
	error: string | null
	truncated: boolean
	originalChars: number
}

const MAX_TOTAL_OUTPUT_CHARS = 150_000

function createAbortError(): Error {
	return new DOMException("aborted", "AbortError")
}

function normalizeUrls(input: { url?: string; urls?: string[] }): string[] {
	const single = typeof input.url === "string" ? input.url.trim() : ""
	const many = Array.isArray(input.urls) ? input.urls.map((u) => u.trim()).filter(Boolean) : []

	if (single && many.length) throw new Error("Provide either url or urls, not both")
	if (!single && !many.length) throw new Error("Provide url or urls")
	return single ? [single] : many
}

function formatFetchBlocks(results: FetchRecord[]): string {
	const lines: string[] = []
	for (const [index, result] of results.entries()) {
		lines.push(`--- Fetch ${index + 1} ---`)
		lines.push(`URL: ${result.url}`)
		if (result.error) {
			lines.push(`Error: ${result.error}`)
			lines.push("")
			continue
		}

		lines.push(`Title: ${result.title}`)
		if (result.truncated) {
			lines.push(`Truncated: yes (${result.originalChars} -> ${result.content.length} chars)`)
		}
		lines.push("Content:")
		lines.push(result.content)
		lines.push("")
	}
	return lines.join("\n").trimEnd()
}

async function runBatch(options: {
	urls: string[]
	format: FetchFormat
	timeoutMs: number
	perUrlMaxChars: number
	concurrency: number
	signal?: AbortSignal
	onUpdate?: (completed: number, total: number) => void
	executeFetch: FetchExecutor
}): Promise<FetchRecord[]> {
	const total = options.urls.length
	const output: Array<FetchRecord | undefined> = new Array(total)
	let next = 0
	let completed = 0

	const worker = async () => {
		while (true) {
			if (options.signal?.aborted) throw createAbortError()
			const current = next
			next += 1
			if (current >= total) return

			const url = options.urls[current]
			const fetched = await options.executeFetch(url, options.format, options.signal, options.timeoutMs)
			if (options.signal?.aborted) throw createAbortError()

			const originalChars = fetched.content.length
			const truncated = !fetched.error && originalChars > options.perUrlMaxChars
			const content = truncated ? fetched.content.slice(0, options.perUrlMaxChars) : fetched.content

			output[current] = {
				url: fetched.url || url,
				title: fetched.title || url,
				content,
				error: fetched.error,
				truncated,
				originalChars,
			}

			completed += 1
			options.onUpdate?.(completed, total)
		}
	}

	const workers = Math.min(options.concurrency, total)
	await Promise.all(Array.from({ length: workers }, () => worker()))
	return output.filter((r): r is FetchRecord => Boolean(r))
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
		promptSnippet: config.label === "Fetch (Rendered)" ? "Fetch URL content through browser rendering" : "Fetch URL content with regular HTTP",
		parameters: fetchParams,
		async execute(_toolCallId, params, signal, onUpdate, _ctx: ExtensionContext) {
			if (signal?.aborted) throw createAbortError()

			const format = params.format ?? "auto"
			const timeoutMs = params.timeoutMs ?? 30_000
			const perUrlMaxChars = params.perUrlMaxChars ?? 3_000
			const concurrency = params.concurrency ?? 3

			let urls: string[]
			try {
				urls = normalizeUrls(params)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return {
					content: [{ type: "text", text: `Error: ${message}` }],
					isError: true,
					details: { error: message, mode: config.mode },
				}
			}

			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${urls.length} URL${urls.length === 1 ? "" : "s"}...` }],
				details: { phase: "fetch", progress: 0.1, mode: config.mode, urlCount: urls.length, fetchedCount: 0 },
			})

			const startedAt = Date.now()
			let results: FetchRecord[]
			try {
				results = await runBatch({
					urls,
					format,
					timeoutMs,
					perUrlMaxChars,
					concurrency,
					signal,
					executeFetch: config.executeFetch,
					onUpdate: (completed, total) => {
						onUpdate?.({
							content: [{ type: "text", text: `Fetched ${completed}/${total}...` }],
							details: {
								phase: "fetch",
								progress: 0.1 + (completed / Math.max(1, total)) * 0.85,
								mode: config.mode,
								urlCount: total,
								fetchedCount: completed,
							},
						})
					},
				})
			} catch (error) {
				if ((error instanceof Error && error.name === "AbortError") || signal?.aborted) {
					throw createAbortError()
				}
				const message = error instanceof Error ? error.message : String(error)
				return {
					content: [{ type: "text", text: `Error: ${message}` }],
					isError: true,
					details: { error: message, mode: config.mode, durationMs: Date.now() - startedAt, urlCount: urls.length },
				}
			}

			const durationMs = Date.now() - startedAt
			const failed = results.filter((r) => r.error).length
			const succeeded = results.length - failed

			if (!results.length) {
				return {
					content: [{ type: "text", text: "Error: No fetch results" }],
					isError: true,
					details: { error: "No fetch results", mode: config.mode, durationMs, urlCount: urls.length, fetchedCount: 0 },
				}
			}

			const rawOutput = formatFetchBlocks(results)
			const aggregateTruncated = rawOutput.length > MAX_TOTAL_OUTPUT_CHARS
			const output = aggregateTruncated
				? `${rawOutput.slice(0, MAX_TOTAL_OUTPUT_CHARS)}\n\n[Output truncated: aggregate limit reached]`
				: rawOutput

			return {
				content: [{ type: "text", text: output }],
				isError: succeeded === 0,
				details: {
					mode: config.mode,
					title: `${succeeded}/${results.length} fetched`,
					totalChars: results.reduce((sum, r) => sum + (r.content?.length ?? 0), 0),
					truncated: results.some((r) => r.truncated) || aggregateTruncated,
					durationMs,
					urlCount: urls.length,
					fetchedCount: succeeded,
					error: succeeded === 0 && failed > 0 ? `${failed}/${results.length} failed` : undefined,
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

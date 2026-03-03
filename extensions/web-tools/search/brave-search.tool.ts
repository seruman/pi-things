import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { z } from "zod"
import { isRetryableNetworkError, isRetryableStatus, parseJson, withExponentialRetries } from "./providers/shared"
import { braveSearchParams, normalizeError, renderToolResult, type ProgressDetails, summarizeSearchResult } from "./tool-ui"

type RetryableError = Error & { retryable?: boolean }

const braveWebResultSchema = z
	.object({
		title: z.string().optional(),
		url: z.string().optional(),
		description: z.string().optional(),
		age: z.string().optional(),
		extra_snippets: z.array(z.string()).optional(),
	})
	.passthrough()

const braveResponseSchema = z
	.object({
		query: z.object({ more_results_available: z.boolean().optional() }).passthrough().optional(),
		web: z.object({ results: z.array(braveWebResultSchema).optional() }).passthrough().optional(),
	})
	.passthrough()

type BraveWebResult = z.infer<typeof braveWebResultSchema>
type BraveResponse = z.infer<typeof braveResponseSchema>


function clip(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text
	return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
}

function clean(text: string): string {
	return text.replace(/\s+/g, " ").trim()
}

function formatResultBlocks(results: BraveWebResult[], includeExtraSnippets: boolean): string {
	const lines: string[] = []

	for (const [index, item] of results.entries()) {
		const title = clean(item.title || item.url || "Untitled")
		const url = clean(item.url || "")
		const snippet = clip(clean(item.description || ""), 500)
		const age = clean(item.age || "")

		lines.push(`--- Result ${index + 1} ---`)
		lines.push(`Title: ${title}`)
		lines.push(`URL: ${url}`)
		if (age) lines.push(`Age: ${age}`)
		lines.push(`Snippet: ${snippet}`)

		if (includeExtraSnippets && item.extra_snippets?.length) {
			const extras = item.extra_snippets.map((s) => clean(s)).filter(Boolean).slice(0, 5)
			if (extras.length) {
				lines.push("Extra Snippets:")
				for (const extra of extras) lines.push(`- ${clip(extra, 220)}`)
			}
		}

		lines.push("")
	}

	return lines.join("\n").trimEnd()
}

function parseBraveErrorMessage(bodyText: string): string {
	const parsed = parseJson(bodyText)
	if (!parsed || typeof parsed !== "object") return bodyText

	const root = parsed as {
		error?: { message?: unknown; detail?: unknown }
		message?: unknown
		detail?: unknown
	}

	if (typeof root.error?.message === "string") return root.error.message
	if (typeof root.error?.detail === "string") return root.error.detail
	if (typeof root.message === "string") return root.message
	if (typeof root.detail === "string") return root.detail
	return bodyText
}

async function runBraveRequest(input: {
	query: string
	count: number
	offset: number
	country: string
	freshness?: string
	searchLang?: string
	uiLang?: string
	safesearch?: "off" | "moderate" | "strict"
	extraSnippets?: boolean
	goggles?: string[]
	signal?: AbortSignal
}): Promise<BraveResponse> {
	const apiKey = process.env.BRAVE_API_KEY?.trim()
	if (!apiKey) throw new Error("BRAVE_API_KEY is not set")

	const params = new URLSearchParams({
		q: input.query,
		count: String(Math.max(1, Math.min(20, input.count))),
		offset: String(Math.max(0, Math.min(9, input.offset))),
		country: input.country.toUpperCase(),
	})

	if (input.freshness) params.set("freshness", input.freshness)
	if (input.searchLang) params.set("search_lang", input.searchLang)
	if (input.uiLang) params.set("ui_lang", input.uiLang)
	if (input.safesearch) params.set("safesearch", input.safesearch)
	if (input.extraSnippets) params.set("extra_snippets", "true")
	for (const goggle of input.goggles || []) {
		const value = goggle.trim()
		if (value) params.append("goggles", value)
	}

	const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
		headers: {
			Accept: "application/json",
			"Accept-Encoding": "gzip",
			"X-Subscription-Token": apiKey,
		},
		signal: input.signal,
	})

	if (!response.ok) {
		const text = await response.text().catch(() => "")
		const message = parseBraveErrorMessage(text) || response.statusText
		const err = new Error(`Brave API error (${response.status}): ${message}`) as RetryableError
		err.retryable = isRetryableStatus(response.status)
		throw err
	}

	const raw = (await response.json()) as unknown
	const parsed = braveResponseSchema.safeParse(raw)
	if (!parsed.success) {
		throw new Error(`Brave API returned unexpected response shape: ${parsed.error.issues[0]?.message || "invalid response"}`)
	}

	return parsed.data
}

export function registerBraveSearchTool(pi: ExtensionAPI) {
	pi.registerTool<typeof braveSearchParams, ProgressDetails>({
		name: "web_search",
		label: "Web Search",
		description: "Search the web using Brave Search API (primary provider). If unavailable/auth fails, use web_search_fallback.",
		parameters: braveSearchParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			const startedAt = Date.now()

			try {
				onUpdate?.({
					content: [{ type: "text", text: "Searching Brave…" }],
					details: { phase: "search", progress: 0.1, label: "search", provider: "brave", query: params.query },
				})

				const response = await withExponentialRetries({
					maxRetries: 2,
					baseDelayMs: 1000,
					signal,
					onRetry: (attempt, maxRetries, reason) => {
						onUpdate?.({
							content: [{ type: "text", text: `Retrying Brave… (${attempt}/${maxRetries})` }],
							details: {
								phase: "retrying",
								progress: 0.45,
								label: "search",
								provider: "brave",
								query: params.query,
								attempt,
								maxRetries,
								reason,
							},
						})
					},
					shouldRetry: (err) => (err as RetryableError).retryable === true || isRetryableNetworkError(err),
					run: async () => {
						onUpdate?.({
							content: [{ type: "text", text: "Requesting Brave API…" }],
							details: {
								phase: "request",
								progress: 0.3,
								label: "search",
								provider: "brave",
								query: params.query,
							},
						})

						return runBraveRequest({
							query: params.query,
							count: params.count ?? 5,
							offset: params.offset ?? 0,
							country: params.country ?? "US",
							freshness: params.freshness,
							searchLang: params.searchLang,
							uiLang: params.uiLang,
							safesearch: params.safesearch,
							extraSnippets: params.extraSnippets,
							goggles: params.goggles,
							signal,
						})
					},
				})

				const webResults = (response.web?.results || [])
					.filter((item) => item.url)
					.slice(0, Math.max(1, Math.min(20, params.count ?? 5)))

				if (!webResults.length) {
					return {
						content: [{ type: "text", text: "No results found." }],
						details: {
							phase: "done",
							progress: 1,
							label: "search",
							summary: "No results",
							provider: "brave",
							query: params.query,
							durationMs: Date.now() - startedAt,
						},
					}
				}

				let content = formatResultBlocks(webResults, params.extraSnippets === true)

				if (params.debug) {
					const more = response.query?.more_results_available === true ? "true" : "false"
					content += ["", "---", "## Debug", "- provider used: brave", `- more_results_available: ${more}`].join(
						"\n",
					)
				}

				return {
					content: [{ type: "text", text: content }],
					details: {
						phase: "done",
						progress: 1,
						label: "search",
						summary: summarizeSearchResult(content),
						provider: "brave",
						query: params.query,
						durationMs: Date.now() - startedAt,
					},
				}
			} catch (error) {
				const normalized = normalizeError(error)
				return {
					content: [{ type: "text", text: `search failed\n\nError: ${normalized.message}` }],
					isError: true,
					details: {
						error: normalized.message,
						phase: "error",
						label: "search",
						statusCode: normalized.statusCode,
						summary: "Brave search failed",
						provider: "brave",
						query: params.query,
						durationMs: Date.now() - startedAt,
					},
				}
			}
		},
		renderResult(result, options, theme) {
			return renderToolResult(result, options, theme)
		},
	})
}

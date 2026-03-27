import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { z } from "zod"
import { isRetryableNetworkError, isRetryableStatus, parseJson, withExponentialRetries } from "./providers/shared"
import { braveSearchParams, normalizeError, renderToolResult, type ProgressDetails, summarizeSearchResult } from "./tool-ui"

type RetryableError = Error & { retryable?: boolean }

type QueryResult = {
	query: string
	results: BraveWebResult[]
	moreResultsAvailable: boolean
	alteredQuery?: string
	operatorsApplied?: boolean
	mutatedByGoggles?: boolean
	error?: string
}

const MAX_TOTAL_OUTPUT_CHARS = 120_000

const braveWebResultSchema = z
	.object({
		title: z.string().optional(),
		url: z.string().optional(),
		description: z.string().optional(),
		age: z.string().optional(),
		extra_snippets: z.array(z.string()).optional(),
		language: z.string().optional(),
		page_age: z.string().optional(),
		profile: z
			.object({
				name: z.string().optional(),
				long_name: z.string().optional(),
			})
			.passthrough()
			.optional(),
		article: z.unknown().optional(),
		faq: z.unknown().optional(),
		video: z.unknown().optional(),
		software: z.unknown().optional(),
		product: z.unknown().optional(),
		review: z.unknown().optional(),
		recipe: z.unknown().optional(),
		book: z.unknown().optional(),
	})
	.passthrough()

const braveResponseSchema = z
	.object({
		query: z
			.object({
				original: z.string().optional(),
				altered: z.string().optional(),
				cleaned: z.string().optional(),
				more_results_available: z.boolean().optional(),
				search_operators: z
					.object({
						applied: z.boolean().optional(),
					})
					.passthrough()
					.optional(),
			})
			.passthrough()
			.optional(),
		web: z
			.object({
				results: z.array(braveWebResultSchema).optional(),
				mutated_by_goggles: z.boolean().optional(),
			})
			.passthrough()
			.optional(),
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

function normalizeQueries(input: { query?: string; queries?: string[] }): string[] {
	const single = typeof input.query === "string" ? input.query.trim() : ""
	const many = Array.isArray(input.queries) ? input.queries.map((q) => q.trim()).filter(Boolean) : []

	if (single && many.length) throw new Error("Provide either query or queries, not both")
	if (!single && !many.length) throw new Error("Provide query or queries")
	return single ? [single] : many
}

function pickSourceName(item: BraveWebResult): string {
	return clean(item.profile?.long_name || item.profile?.name || "")
}

function collectTypeHints(item: BraveWebResult): string[] {
	const hints: string[] = []
	if (item.article != null) hints.push("article")
	if (item.faq != null) hints.push("faq")
	if (item.video != null) hints.push("video")
	if (item.software != null) hints.push("software")
	if (item.product != null) hints.push("product")
	if (item.review != null) hints.push("review")
	if (item.recipe != null) hints.push("recipe")
	if (item.book != null) hints.push("book")
	return hints
}

function formatSingleResultBlocks(
	results: BraveWebResult[],
	includeExtraSnippets: boolean,
	options: { showLanguage: boolean },
): string {
	const lines: string[] = []
	for (const [index, item] of results.entries()) {
		const title = clean(item.title || item.url || "Untitled")
		const url = clean(item.url || "")
		const source = pickSourceName(item)
		const language = clean(item.language || "")
		const snippet = clip(clean(item.description || ""), 500)
		const age = clean(item.age || "")
		const published = clean(item.page_age || "")
		const typeHints = collectTypeHints(item)

		lines.push(`--- Result ${index + 1} ---`)
		lines.push(`Title: ${title}`)
		lines.push(`URL: ${url}`)
		if (source) lines.push(`Source: ${source}`)
		if (options.showLanguage && language) lines.push(`Language: ${language}`)
		if (age) lines.push(`Age: ${age}`)
		if (published) lines.push(`Published: ${published}`)
		lines.push(`Snippet: ${snippet}`)
		if (typeHints.length) lines.push(`Type Hints: ${typeHints.join(", ")}`)

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

function formatBatchResultBlocks(
	results: QueryResult[],
	includeExtraSnippets: boolean,
	debug: boolean,
	options: { showLanguage: boolean },
): string {
	const lines: string[] = []
	for (const [index, section] of results.entries()) {
		lines.push(`=== Query ${index + 1} ===`)
		lines.push(`Query: ${section.query}`)
		if (section.alteredQuery && clean(section.alteredQuery) && clean(section.alteredQuery) !== clean(section.query)) {
			lines.push(`Altered Query: ${clean(section.alteredQuery)}`)
		}
		lines.push(`More Results Available: ${section.moreResultsAvailable ? "true" : "false"}`)
		if (section.mutatedByGoggles) lines.push("Re-ranked by Goggles: yes")
		if (section.operatorsApplied === true) lines.push("Operators Applied: yes")
		if (section.error) {
			lines.push(`Error: ${section.error}`)
			lines.push("")
			continue
		}

		if (!section.results.length) {
			lines.push("No results found.")
			if (debug) {
				lines.push("Debug:")
				lines.push("- provider used: brave")
				if (section.operatorsApplied !== undefined) lines.push(`- operators_applied: ${section.operatorsApplied ? "true" : "false"}`)
			}
			lines.push("")
			continue
		}

		lines.push(formatSingleResultBlocks(section.results, includeExtraSnippets, options))
		if (debug) {
			lines.push("Debug:")
			lines.push("- provider used: brave")
			if (section.operatorsApplied !== undefined) lines.push(`- operators_applied: ${section.operatorsApplied ? "true" : "false"}`)
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
	const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim() || process.env.BRAVE_API_KEY?.trim()
	if (!apiKey) throw new Error("Brave API key is not set (set BRAVE_SEARCH_API_KEY)")

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

async function runBatch(options: {
	queries: string[]
	count: number
	offset: number
	country: string
	freshness?: string
	searchLang?: string
	uiLang?: string
	safesearch?: "off" | "moderate" | "strict"
	extraSnippets?: boolean
	goggles?: string[]
	concurrency: number
	signal?: AbortSignal
	onUpdate?: (completed: number, total: number, activeQuery?: string) => void
}): Promise<QueryResult[]> {
	const total = options.queries.length
	const output: Array<QueryResult | undefined> = new Array(total)
	let next = 0
	let completed = 0

	const worker = async () => {
		while (true) {
			if (options.signal?.aborted) throw new DOMException("aborted", "AbortError")
			const current = next
			next += 1
			if (current >= total) return

			const query = options.queries[current]
			try {
				const response = await withExponentialRetries({
					maxRetries: 2,
					baseDelayMs: 1000,
					signal: options.signal,
					shouldRetry: (err) => (err as RetryableError).retryable === true || isRetryableNetworkError(err),
					run: async () =>
						runBraveRequest({
							query,
							count: options.count,
							offset: options.offset,
							country: options.country,
							freshness: options.freshness,
							searchLang: options.searchLang,
							uiLang: options.uiLang,
							safesearch: options.safesearch,
							extraSnippets: options.extraSnippets,
							goggles: options.goggles,
							signal: options.signal,
						}),
				})

				const results = (response.web?.results || [])
					.filter((item) => item.url)
					.slice(0, Math.max(1, Math.min(20, options.count)))

				output[current] = {
					query,
					results,
					moreResultsAvailable: response.query?.more_results_available === true,
					alteredQuery: response.query?.altered,
					operatorsApplied: response.query?.search_operators?.applied,
					mutatedByGoggles: response.web?.mutated_by_goggles === true,
				}
			} catch (error) {
				if ((error instanceof Error && error.name === "AbortError") || options.signal?.aborted) throw error
				const normalized = normalizeError(error)
				output[current] = {
					query,
					results: [],
					moreResultsAvailable: false,
					error: normalized.message,
				}
			}

			completed += 1
			options.onUpdate?.(completed, total, query)
		}
	}

	const workers = Math.min(Math.max(1, options.concurrency), total)
	await Promise.all(Array.from({ length: workers }, () => worker()))
	return output.filter((item): item is QueryResult => Boolean(item))
}

export function registerBraveSearchTool(pi: ExtensionAPI) {
	pi.registerTool<typeof braveSearchParams, ProgressDetails>({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using Brave Search API (primary provider). Supports single query or batched queries. If unavailable/auth fails, use web_search_fallback.",
		promptSnippet: "Search the web using Brave Search API",
		parameters: braveSearchParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			if (signal?.aborted) throw new DOMException("aborted", "AbortError")
			const startedAt = Date.now()

			let queries: string[]
			try {
				queries = normalizeQueries(params)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return {
					content: [{ type: "text", text: `Error: ${message}` }],
					isError: true,
					details: { error: message, phase: "error", label: "search", provider: "brave" },
				}
			}

			const querySummary =
				queries.length === 1 ? queries[0] : `${queries[0]} +${Math.max(0, queries.length - 1)} more`
			const detailQueries = queries.length > 1 ? queries : undefined
			const isBatch = queries.length > 1
			const perQueryCount = params.count ?? (isBatch ? 3 : 5)
			const concurrency = params.concurrency ?? 3

			onUpdate?.({
				content: [{ type: "text", text: `Searching Brave (${queries.length} quer${queries.length === 1 ? "y" : "ies"})…` }],
				details: {
					phase: "search",
					progress: 0.1,
					label: "search",
					provider: "brave",
					query: querySummary,
					queries: detailQueries,
				},
			})

			let queryResults: QueryResult[]
			try {
				queryResults = await runBatch({
					queries,
					count: perQueryCount,
					offset: params.offset ?? 0,
					country: params.country ?? "US",
					freshness: params.freshness,
					searchLang: params.searchLang,
					uiLang: params.uiLang,
					safesearch: params.safesearch,
					extraSnippets: params.extraSnippets,
					goggles: params.goggles,
					concurrency,
					signal,
					onUpdate: (completed, total, activeQuery) => {
						onUpdate?.({
							content: [{ type: "text", text: `Searched ${completed}/${total}${activeQuery ? ` · ${activeQuery}` : ""}` }],
							details: {
								phase: "search",
								progress: 0.1 + (completed / Math.max(1, total)) * 0.85,
								label: "search",
								provider: "brave",
								query: querySummary,
								queries: detailQueries,
							},
						})
					},
				})
			} catch (error) {
				if ((error instanceof Error && error.name === "AbortError") || signal?.aborted) {
					throw new DOMException("aborted", "AbortError")
				}
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
						query: querySummary,
						queries: detailQueries,
						durationMs: Date.now() - startedAt,
					},
				}
			}

			const failed = queryResults.filter((q) => q.error).length
			const successful = queryResults.length - failed
			const content = formatBatchResultBlocks(queryResults, params.extraSnippets === true, params.debug === true, {
				showLanguage: Boolean(params.searchLang),
			})
			const aggregateTruncated = content.length > MAX_TOTAL_OUTPUT_CHARS
			const output = aggregateTruncated
				? `${content.slice(0, MAX_TOTAL_OUTPUT_CHARS)}\n\n[Output truncated: aggregate limit reached]`
				: content

			return {
				content: [{ type: "text", text: output }],
				isError: successful === 0,
				details: {
					phase: "done",
					progress: 1,
					label: "search",
					summary: summarizeSearchResult(output),
					provider: "brave",
					query: querySummary,
					queries: detailQueries,
					error: successful === 0 && failed > 0 ? `${failed}/${queryResults.length} queries failed` : undefined,
					durationMs: Date.now() - startedAt,
				},
			}
		},
		renderResult(result, options, theme) {
			return renderToolResult(result, options, theme)
		},
	})
}

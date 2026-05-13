import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { z } from "zod"
import { isRetryableNetworkError, isRetryableStatus, parseJson, withExponentialRetries } from "./providers/shared"
import {
	type ProgressDetails,
	braveSearchParams,
	normalizeError,
	renderToolResult,
	summarizeSearchResult,
} from "./tool-ui"

type RetryableError = Error & { retryable?: boolean }

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
				altered: z.string().optional(),
				more_results_available: z.boolean().optional(),
				search_operators: z.object({ applied: z.boolean().optional() }).passthrough().optional(),
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

function formatResults(
	query: string,
	response: BraveResponse,
	results: BraveWebResult[],
	includeExtraSnippets: boolean,
	debug: boolean,
	showLanguage: boolean,
): string {
	const lines: string[] = [`Query: ${query}`]
	if (response.query?.altered && clean(response.query.altered) !== clean(query)) {
		lines.push(`Altered Query: ${clean(response.query.altered)}`)
	}
	lines.push(`More Results Available: ${response.query?.more_results_available === true ? "true" : "false"}`)
	if (response.web?.mutated_by_goggles) lines.push("Re-ranked by Goggles: yes")
	if (response.query?.search_operators?.applied === true) lines.push("Operators Applied: yes")
	lines.push("")

	if (!results.length) {
		lines.push("No results found.")
	} else {
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
			if (showLanguage && language) lines.push(`Language: ${language}`)
			if (age) lines.push(`Age: ${age}`)
			if (published) lines.push(`Published: ${published}`)
			lines.push(`Snippet: ${snippet}`)
			if (typeHints.length) lines.push(`Type Hints: ${typeHints.join(", ")}`)

			if (includeExtraSnippets && item.extra_snippets?.length) {
				const extras = item.extra_snippets
					.map((s) => clean(s))
					.filter(Boolean)
					.slice(0, 5)
				if (extras.length) {
					lines.push("Extra Snippets:")
					for (const extra of extras) lines.push(`- ${clip(extra, 220)}`)
				}
			}

			lines.push("")
		}
	}

	if (debug) {
		lines.push("Debug:")
		lines.push("- provider used: brave")
		if (response.query?.search_operators?.applied !== undefined) {
			lines.push(`- operators_applied: ${response.query.search_operators.applied ? "true" : "false"}`)
		}
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
		throw new Error(
			`Brave API returned unexpected response shape: ${parsed.error.issues[0]?.message || "invalid response"}`,
		)
	}

	return parsed.data
}

export function registerBraveSearchTool(pi: ExtensionAPI) {
	pi.registerTool<typeof braveSearchParams, ProgressDetails>({
		name: "web_search",
		label: "Web Search",
		description: "Search the web using Brave Search API.",
		promptSnippet: "Search the web using Brave Search API",
		parameters: braveSearchParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			if (signal?.aborted) throw new DOMException("aborted", "AbortError")
			const startedAt = Date.now()
			const query = params.query.trim()
			if (!query) {
				return {
					content: [{ type: "text", text: "Error: query is required" }],
					isError: true,
					details: { error: "query is required", phase: "error", label: "search", provider: "brave" },
				}
			}

			onUpdate?.({
				content: [{ type: "text", text: `Searching Brave: ${query}` }],
				details: { phase: "search", progress: 0.1, label: "search", provider: "brave", query },
			})

			let response: BraveResponse
			try {
				response = await withExponentialRetries({
					maxRetries: 2,
					baseDelayMs: 1000,
					signal,
					shouldRetry: (err) => (err as RetryableError).retryable === true || isRetryableNetworkError(err),
					run: async () =>
						runBraveRequest({
							query,
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
						}),
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
						query,
						durationMs: Date.now() - startedAt,
					},
				}
			}

			const results = (response.web?.results || [])
				.filter((item) => item.url)
				.slice(0, Math.max(1, Math.min(20, params.count ?? 5)))
			const content = formatResults(
				query,
				response,
				results,
				params.extraSnippets === true,
				params.debug === true,
				Boolean(params.searchLang),
			)
			const output =
				content.length > MAX_TOTAL_OUTPUT_CHARS
					? `${content.slice(0, MAX_TOTAL_OUTPUT_CHARS)}\n\n[Output truncated: aggregate limit reached]`
					: content

			return {
				content: [{ type: "text", text: output }],
				isError: false,
				details: {
					phase: "done",
					progress: 1,
					label: "search",
					summary: summarizeSearchResult(output),
					provider: "brave",
					query,
					durationMs: Date.now() - startedAt,
				},
			}
		},
		renderResult(result, options, theme) {
			return renderToolResult(result, options, theme)
		},
	})
}

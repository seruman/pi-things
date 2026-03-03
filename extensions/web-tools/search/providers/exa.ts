import type { ExtensionContext } from "@mariozechner/pi-coding-agent"
import { z } from "zod"
import type { SearchProvider, SearchSource } from "../types"
import {
	createRequestSignal,
	isRetryableNetworkError,
	isRetryableStatus,
	parseJson,
	withExponentialRetries,
} from "./shared"

const BASE_URL = "https://mcp.exa.ai"
const MODEL = "exa-mcp-web_search_exa"
const TIMEOUT_MS = 25_000
const MAX_RETRIES = 2
const RETRY_BASE_MS = 1_000

const EXA_NUM_RESULTS = 5
const EXA_CONTEXT_MAX_CHARS = 3_000
const MAX_RENDERED_RESULTS = 5
const MAX_SNIPPET_CHARS = 280

const mcpEnvelopeSchema = z
	.object({
		jsonrpc: z.string().optional(),
		result: z
			.object({
				content: z
					.array(
						z
							.object({
								type: z.string().optional(),
								text: z.string().optional(),
							})
							.passthrough(),
					)
					.optional(),
			})
			.passthrough()
			.optional(),
		error: z
			.object({
				message: z.string().optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough()

type RetryableError = Error & { retryable?: boolean }

type ParsedResult = {
	title: string
	url: string
	snippet?: string
}

function clip(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text
	return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
}

function clean(text: string): string {
	return text.replace(/\s+/g, " ").trim()
}

function parseTitleUrlBlocks(text: string): ParsedResult[] {
	const normalized = text.replace(/\r\n/g, "\n")
	const blockRegex = /(?:^|\n)Title:\s*(.+?)\n([\s\S]*?)(?=\nTitle:\s|$)/g
	const items: ParsedResult[] = []

	for (const match of normalized.matchAll(blockRegex)) {
		const title = clean(match[1] || "")
		const block = match[2] || ""
		const urlMatch = block.match(/(?:^|\n)URL:\s*(\S+)/)
		if (!title || !urlMatch?.[1]) continue

		const url = clean(urlMatch[1])
		const textMatch = block.match(/(?:^|\n)Text:\s*([\s\S]*?)$/)
		const snippet = textMatch?.[1] ? clip(clean(textMatch[1]), MAX_SNIPPET_CHARS) : undefined
		items.push({ title, url, snippet })
	}

	return items
}

function formatParsedResults(query: string, results: ParsedResult[]): string {
	const top = results.slice(0, MAX_RENDERED_RESULTS)
	const lines = [`Top Exa matches for: ${query}`, ""]

	for (const [i, result] of top.entries()) {
		const head = `${i + 1}. [${result.title}](${result.url})`
		if (result.snippet) {
			lines.push(`${head} — ${result.snippet}`)
		} else {
			lines.push(head)
		}
	}

	return lines.join("\n")
}

function parseMcpTextPayload(raw: string): string | null {
	const normalized = raw.replace(/\r\n/g, "\n")
	for (const line of normalized.split("\n")) {
		if (!line.startsWith("data:")) continue
		const json = line.slice(5).trim()
		if (!json || json === "[DONE]") continue
		const payload = parseJson(json)
		const parsed = mcpEnvelopeSchema.safeParse(payload)
		if (!parsed.success) continue
		const text = parsed.data.result?.content?.find((item) => typeof item.text === "string")?.text?.trim()
		if (text) return text
		if (parsed.data.error?.message) throw new Error(parsed.data.error.message)
	}

	const directPayload = parseJson(raw)
	const parsed = mcpEnvelopeSchema.safeParse(directPayload)
	if (!parsed.success) return null
	const directText = parsed.data.result?.content?.find((item) => typeof item.text === "string")?.text?.trim()
	if (directText) return directText
	if (parsed.data.error?.message) throw new Error(parsed.data.error.message)
	return null
}

export const exaProvider: SearchProvider = {
	id: "exa",
	async isAvailable(_ctx: ExtensionContext): Promise<boolean> {
		return true
	},
	async run(_ctx, input) {
		const query = input.query.trim()
		if (!query) throw new Error("query cannot be empty")

		return withExponentialRetries({
			maxRetries: MAX_RETRIES,
			baseDelayMs: RETRY_BASE_MS,
			signal: input.signal,
			onRetry: (attempt, maxRetries, reason) => {
				input.onEvent?.({ type: "retry", provider: "exa", attempt, maxRetries, reason })
			},
			shouldRetry: (err) => (err as RetryableError).retryable === true || isRetryableNetworkError(err),
			run: async () => {
				input.onEvent?.({ type: "status", provider: "exa", phase: "request", message: "trying exa" })

				const body = {
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: {
						name: "web_search_exa",
						arguments: {
							query,
							type: "fast",
							numResults: EXA_NUM_RESULTS,
							...(input.live === false ? {} : { livecrawl: "fallback" }),
							contextMaxCharacters: EXA_CONTEXT_MAX_CHARS,
						},
					},
				}

				const response = await fetch(`${BASE_URL}/mcp`, {
					method: "POST",
					headers: {
						accept: "application/json, text/event-stream",
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
					signal: createRequestSignal(input.signal, TIMEOUT_MS),
				})

				if (!response.ok) {
					const text = await response.text().catch(() => "")
					const err = new Error(`Exa API error (${response.status}): ${text || response.statusText}`) as RetryableError
					err.retryable = isRetryableStatus(response.status)
					throw err
				}

				const raw = await response.text()
				const rawText = parseMcpTextPayload(raw)
				if (!rawText) throw new Error("Exa returned no text content")

				const parsedResults = parseTitleUrlBlocks(rawText)
				if (parsedResults.length > 0) {
					const sources: SearchSource[] = parsedResults.slice(0, MAX_RENDERED_RESULTS).map((item) => ({
						url: item.url,
						title: item.title,
					}))
					return {
						provider: "exa",
						model: MODEL,
						text: formatParsedResults(query, parsedResults),
						sources,
					}
				}

				return {
					provider: "exa",
					model: MODEL,
					text: clip(clean(rawText), 1_200),
					sources: [],
				}
			},
		})
	},
}

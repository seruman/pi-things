import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { geminiProvider } from "./providers/gemini"
import { openaiProvider } from "./providers/openai"
import { normalizeError, type ProgressDetails, renderToolResult, searchParams, summarizeSearchResult } from "./tool-ui"
import type { SearchAttemptFailure, SearchProvider, SearchProviderId, SearchResult, SearchRunInput } from "./types"

const providers: Record<SearchProviderId, SearchProvider> = {
	openai: openaiProvider,
	gemini: geminiProvider,
}

async function runSearchWithFallback(
	ctx: ExtensionContext,
	input: SearchRunInput & { providers?: SearchProviderId[] },
): Promise<{ result: SearchResult; failures: SearchAttemptFailure[] }> {
	const failures: SearchAttemptFailure[] = []

	const defaults: SearchProviderId[] = ["gemini", "openai"]
	const ordered: SearchProviderId[] = []
	for (const id of input.providers?.length ? input.providers : defaults) {
		if (!ordered.includes(id)) ordered.push(id)
	}

	for (const id of ordered) {
		const provider = providers[id]

		const available = await provider.isAvailable(ctx).catch(() => false)
		if (!available) {
			failures.push({ provider: id, error: "not authenticated" })
			input.onEvent?.({ type: "status", provider: id, phase: "auth", message: `${id} not authenticated` })
			continue
		}

		input.onEvent?.({ type: "status", provider: id, phase: "request", message: `trying ${id}` })

		try {
			const result = await provider.run(ctx, input)
			input.onEvent?.({ type: "status", provider: id, phase: "finalizing", message: `${id} done` })
			return { result, failures }
		} catch (error) {
			failures.push({
				provider: id,
				error: error instanceof Error ? error.message : String(error),
			})
			input.onEvent?.({ type: "status", provider: id, phase: "request", message: `${id} failed, trying next` })
		}
	}

	throw new Error(`All search providers failed:\n${failures.map((f) => `${f.provider}: ${f.error}`).join("\n")}`)
}

function formatSources(sources: Array<{ url: string; title?: string }>): string {
	if (!sources.length) return ""
	const lines = sources.map((s, i) => `${i + 1}. ${s.url}`)
	return `\n\nSources\n\n${lines.join("\n")}`
}

export function registerSearchTool(pi: ExtensionAPI) {
	pi.registerTool<typeof searchParams, ProgressDetails>({
		name: "web_search",
		label: "Web Search",
		description: "Search the web using available providers (OpenAI/Gemini) with automatic fallback.",
		parameters: searchParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
			const startedAt = Date.now()
			try {
				onUpdate?.({
					content: [{ type: "text", text: "Searching…" }],
					details: { phase: "search", progress: 0, label: "search", query: params.query },
				})

				const { result, failures } = await runSearchWithFallback(ctx, {
					query: params.query,
					providers: params.providers,
					live: params.live,
					debug: params.debug,
					signal,
					onEvent: (event) => {
						if (event.type === "retry") {
							onUpdate?.({
								content: [{ type: "text", text: `Retrying… (${event.attempt}/${event.maxRetries})` }],
								details: {
									phase: "retrying",
									progress: 0.7,
									label: "search",
									provider: event.provider,
									query: params.query,
									attempt: event.attempt,
									maxRetries: event.maxRetries,
									reason: event.reason,
								},
							})
							return
						}

						if (event.type === "partial") {
							onUpdate?.({
								content: [{ type: "text", text: event.text || "Searching…" }],
								details: {
									phase: "streaming",
									progress: 0.92,
									label: "search",
									provider: event.provider,
									query: params.query,
								},
							})
							return
						}

						onUpdate?.({
							content: [{ type: "text", text: event.message || "Searching…" }],
							details: {
								phase: event.phase,
								progress: event.phase === "finalizing" ? 0.97 : 0.4,
								label: "search",
								provider: event.provider,
								query: params.query,
							},
						})
					},
				})

				let content = `${result.text}${formatSources(result.sources)}`
				if (params.debug) {
					const failureLines = failures.length
						? failures.map((f) => `- ${f.provider}: ${f.error}`).join("\n")
						: "- none"
					content += [
						"",
						"---",
						"## Debug",
						`- provider used: ${result.provider}`,
						`- model: ${result.model || "unknown"}`,
						"",
						"### Fallback attempts",
						failureLines,
					].join("\n")
				}

				return {
					content: [{ type: "text", text: content }],
					details: {
						phase: "done",
						progress: 1,
						label: "search",
						summary: summarizeSearchResult(result.text),
						provider: result.provider,
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
						summary: "Search failed",
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

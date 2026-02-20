import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { executeWebSearch } from "./search";
import {
  normalizeError,
  renderToolResult,
  summarizeSearchResult,
  type ProgressDetails,
  webSearchParams,
} from "./tool-ui";

export default function (pi: ExtensionAPI) {
  pi.registerTool<typeof webSearchParams, ProgressDetails>({
    name: "gemini_web_search",
    label: "Web Search",
    description:
      "Search the web using Gemini subscription auth (from /login gemini). Returns a concise answer and source links.",
    parameters: webSearchParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
      try {
        onUpdate?.({
          content: [{ type: "text", text: "Searching…" }],
          details: { phase: "search", progress: 0, label: "search" },
        });

        const result = await executeWebSearch(params.query, signal, ctx, {
          onRetry: (attempt, maxRetries, reason) => {
            onUpdate?.({
              content: [{ type: "text", text: `Retrying search… (${attempt}/${maxRetries})` }],
              details: {
                phase: "retrying",
                progress: Math.min((0.2 + attempt / Math.max(1, maxRetries + 1)) * 0.6, 0.9),
                label: "search",
                attempt,
                maxRetries,
                reason,
              },
            });
          },
          onPartial: (text) => {
            onUpdate?.({
              content: [{ type: "text", text: text || "Searching…" }],
              details: { phase: "streaming", progress: 0.92, label: "search" },
            });
          },
        }, { debug: params.debug === true });

        return {
          content: [{ type: "text", text: result }],
          details: {
            phase: "done",
            progress: 1,
            label: "search",
            summary: summarizeSearchResult(result),
          },
        };
      } catch (error) {
        const normalized = normalizeError(error);
        return {
          content: [{ type: "text", text: `gemini_web_search failed\n\nError: ${normalized.message}` }],
          isError: true,
          details: {
            error: normalized.message,
            phase: "error",
            label: "search",
            statusCode: normalized.statusCode,
            summary: "Search failed",
          },
        };
      }
    },
    renderResult(result, options, theme) {
      return renderToolResult(result, options, theme);
    },
  });
}

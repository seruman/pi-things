import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { formatSources, runCloudCodeAssistPromptStream } from "./gemini-auth";

type SearchHooks = {
  onPartial?: (text: string) => void;
  onRetry?: (attempt: number, maxRetries: number, reason?: string) => void;
};

type SearchOptions = {
  debug?: boolean;
};

function normalizeAnswer(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clip(text: string, maxChars = 8000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`;
}

function renderDebugSection(modelText: string, transformedText: string, raw: unknown): string {
  const rawJson = (() => {
    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      return String(raw);
    }
  })();

  return [
    "",
    "---",
    "## Debug: raw Gemini output",
    "",
    "### modelText (exact extracted candidate text)",
    "```text",
    clip(modelText || ""),
    "```",
    "",
    "### transformedText (after citation insertion/normalization)",
    "```text",
    clip(transformedText || ""),
    "```",
    "",
    "### raw payload",
    "```json",
    clip(rawJson),
    "```",
  ].join("\n");
}

export async function executeWebSearch(
  query: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  hooks?: SearchHooks,
  options?: SearchOptions,
): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("query cannot be empty");

  const prompt = [
    `Search the web for: ${trimmed}`,
    "Provide a concise, factual answer in markdown.",
    "Prefer high-signal sources and include key points only.",
  ].join("\n");

  let lastRender = 0;

  const result = await runCloudCodeAssistPromptStream({
    ctx,
    signal,
    prompt,
    tool: "googleSearch",
    onRetry: hooks?.onRetry,
    onTextDelta: (_delta, accumulated) => {
      const now = Date.now();
      if (now - lastRender > 200) {
        hooks?.onPartial?.(accumulated);
        lastRender = now;
      }
    },
  });

  const answer = normalizeAnswer(result.text || `No results for query: ${trimmed}`);
  const content = `${answer}${formatSources(result.sources)}`;
  if (!options?.debug) return content;

  return `${content}${renderDebugSection(result.modelText, result.text, result.raw)}`;
}

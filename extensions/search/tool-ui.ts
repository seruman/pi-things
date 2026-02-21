import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

export type ProgressDetails = {
  phase?: string;
  progress?: number;
  label?: string;
  attempt?: number;
  maxRetries?: number;
  reason?: string;
  summary?: string;
  statusCode?: number;
  error?: string;
  provider?: string;
};

export const searchParams = Type.Object({
  query: Type.String({ description: "The search query" }),
  providers: Type.Optional(
    Type.Array(
      Type.Union([Type.Literal("openai"), Type.Literal("gemini")]),
      { minItems: 1, description: "Provider fallback order (default: [\"gemini\", \"openai\"])" },
    ),
  ),
  live: Type.Optional(Type.Boolean({ description: "Use live web access when provider supports it (default: true)" })),
  debug: Type.Optional(Type.Boolean({ description: "Include debug details in output" })),
});

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function normalizeError(error: unknown): { message: string; statusCode?: number } {
  const message = asErrorMessage(error).trim();
  const match = message.match(/API error\s*\((\d{3})\)/i) ?? message.match(/\b(\d{3})\b/);
  const statusCode = match ? Number(match[1]) : undefined;
  return { message, statusCode: Number.isFinite(statusCode) ? statusCode : undefined };
}

function firstMeaningfulLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("[") && l !== "---");
  return line ?? text.trim();
}

export function summarizeSearchResult(text: string): string {
  const line = firstMeaningfulLine(text).replace(/\*\*/g, "");
  const clipped = line.length > 90 ? `${line.slice(0, 87)}...` : line;
  return clipped || "Search completed";
}

function progressBar(progress: number | undefined, width = 10): string {
  const p = typeof progress === "number" ? Math.max(0, Math.min(1, progress)) : 0;
  const filled = Math.floor(p * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function firstTextContent(result: AgentToolResult<ProgressDetails>): string {
  for (const block of result.content) {
    if (block.type === "text") return block.text?.trim() ?? "";
  }
  return "";
}

export function renderToolResult(
  result: AgentToolResult<ProgressDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Text {
  const details = result.details;

  if (options.isPartial) {
    const label = details.label || "search";
    const phase = details.phase || "working";
    const provider = details.provider ? ` · ${details.provider}` : "";
    const bar = progressBar(details.progress, 10);
    let suffix = `${label}${provider}`;
    if (phase === "retrying" && details.attempt && details.maxRetries) {
      const why = details.reason ? ` · ${details.reason}` : "";
      suffix = `${label}${provider} retry ${details.attempt}/${details.maxRetries}${why}`;
    } else if (phase === "streaming") {
      suffix = `${label}${provider} streaming`;
    }
    return new Text(theme.fg("accent", `[${bar}] ${suffix}`), 0, 0);
  }

  if (details.error) {
    const code = details.statusCode ? ` (${details.statusCode})` : "";
    const head = details.summary || "search failed";
    return new Text(
      `${theme.fg("error", theme.bold(`✗ ${head}${code}`))}\n${theme.fg("dim", details.error)}`,
      0,
      0,
    );
  }

  const text = firstTextContent(result) || "search completed";

  if (!options.expanded) {
    const summary = details.summary || firstMeaningfulLine(text);
    const clipped = summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
    return new Text(`${theme.fg("success", theme.bold("✓ done"))}\n${theme.fg("dim", clipped)}`, 0, 0);
  }

  return new Text(text, 0, 0);
}

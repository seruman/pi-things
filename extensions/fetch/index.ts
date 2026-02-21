import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  fetchOneHttp,
  fetchOneRendered,
  fetchParams,
  MAX_INLINE_CONTENT,
  type FetchDetails,
  type FetchFormat,
  type FetchMode,
} from "./fetch-lib";
import { renderFetchCall, renderFetchResult } from "./fetch-ui";

type FetchExecutor = (
  url: string,
  format: FetchFormat,
  signal: AbortSignal | undefined,
  timeoutMs: number,
) => Promise<{ url: string; title: string; content: string; error: string | null }>;

function registerFetchTool(
  pi: ExtensionAPI,
  config: {
    name: string;
    label: string;
    description: string;
    mode: FetchMode;
    executeFetch: FetchExecutor;
  },
) {
  pi.registerTool<typeof fetchParams, FetchDetails>({
    name: config.name,
    label: config.label,
    description: config.description,
    parameters: fetchParams,
    async execute(_toolCallId, params, signal, onUpdate, _ctx: ExtensionContext) {
      const format = params.format ?? "auto";
      const timeoutMs = params.timeoutMs ?? 30_000;

      onUpdate?.({
        content: [{ type: "text", text: `Fetching ${params.url}...` }],
        details: { phase: "fetch", progress: 0.1, mode: config.mode },
      });

      const startedAt = Date.now();
      const result = await config.executeFetch(params.url, format, signal, timeoutMs);
      const durationMs = Date.now() - startedAt;

      if (result.error) {
        return {
          content: [{ type: "text", text: `Error: ${result.error}` }],
          isError: true,
          details: { error: result.error, mode: config.mode, durationMs },
        };
      }

      const truncated = result.content.length > MAX_INLINE_CONTENT;
      let output = truncated ? result.content.slice(0, MAX_INLINE_CONTENT) : result.content;
      if (truncated) output += "\n\n[Content truncated...]";

      return {
        content: [{ type: "text", text: output }],
        details: {
          mode: config.mode,
          title: result.title,
          totalChars: result.content.length,
          truncated,
          durationMs,
        },
      };
    },
    renderCall(args, theme) {
      return renderFetchCall(args, theme);
    },
    renderResult(result, opts, theme) {
      return renderFetchResult(result, opts, theme);
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerFetchTool(pi, {
    name: "fetch_content",
    label: "Fetch Content",
    description:
      "Fetch URL content with regular HTTP and extract readable output. Supports format=auto|markdown|text|html and timeoutMs.",
    mode: "http",
    executeFetch: fetchOneHttp,
  });

  registerFetchTool(pi, {
    name: "fetch_rendered",
    label: "Fetch Rendered",
    description:
      "Fetch URL content through browser rendering (Lightpanda) and extract readable output. Supports format=auto|markdown|text|html and timeoutMs.",
    mode: "rendered",
    executeFetch: fetchOneRendered,
  });
}

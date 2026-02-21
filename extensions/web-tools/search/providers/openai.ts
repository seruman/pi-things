import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { z } from "zod";
import type { SearchProvider } from "../types";
import {
  consumeSseJson,
  createRequestSignal,
  isRetryableNetworkError,
  isRetryableStatus,
  parseJson,
  withExponentialRetries,
} from "./shared";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const MODEL = "gpt-5.3-codex";
const TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1_000;

const credentialSchema = z.object({
  type: z.literal("oauth"),
  accountId: z.string().optional(),
}).passthrough();

const webSearchItemSchema = z.object({
  type: z.literal("web_search_call"),
  action: z
    .object({
      type: z.enum(["search", "open_page", "find_in_page", "other"]),
    })
    .passthrough()
    .optional(),
}).passthrough();

const messageItemSchema = z.object({
  type: z.literal("message"),
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
      annotations: z.array(
        z.object({ type: z.string(), url: z.string().optional(), title: z.string().optional() }).passthrough(),
      ).optional(),
    }).passthrough(),
  ),
}).passthrough();

const streamEventSchema = z.object({
  type: z.string(),
  response: z
    .object({
      headers: z.record(z.unknown()).optional(),
      error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
      incomplete_details: z.object({ reason: z.string().optional() }).optional(),
    })
    .passthrough()
    .optional(),
  item: z.record(z.unknown()).optional(),
  delta: z.string().optional(),
}).passthrough();

type RetryableError = Error & { retryable?: boolean };

export const openaiProvider: SearchProvider = {
  id: "openai",
  async isAvailable(ctx: ExtensionContext): Promise<boolean> {
    return credentialSchema.safeParse(ctx.modelRegistry.authStorage.get(OPENAI_CODEX_PROVIDER)).success;
  },
  async run(ctx, input) {
    const parsedCredential = credentialSchema.safeParse(ctx.modelRegistry.authStorage.get(OPENAI_CODEX_PROVIDER));
    if (!parsedCredential.success) throw new Error("openai-codex not authenticated");

    const token = await ctx.modelRegistry.getApiKeyForProvider(OPENAI_CODEX_PROVIDER);
    if (!token?.trim()) throw new Error("openai-codex token unavailable");

    const found = ctx.modelRegistry.find(OPENAI_CODEX_PROVIDER, MODEL);
    const baseUrl = (found && typeof found.baseUrl === "string" ? found.baseUrl : DEFAULT_BASE_URL).replace(/\/+$/, "");
    const url = `${baseUrl}/codex/responses`;

    const body = {
      model: MODEL,
      instructions: "You are a helpful search assistant. Provide concise, factual answers in markdown.",
      input: [{ role: "user", content: `Search the web for: ${input.query}\nProvide a concise, factual answer in markdown. Include key points only.` }],
      tools: [{ type: "web_search", ...(input.live === false ? {} : { external_web_access: true }) }],
      tool_choice: "auto",
      stream: true,
      store: false,
    };

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token.trim()}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      originator: "codex_cli_rs",
    };
    if (parsedCredential.data.accountId) headers["chatgpt-account-id"] = parsedCredential.data.accountId;

    return withExponentialRetries({
      maxRetries: MAX_RETRIES,
      baseDelayMs: RETRY_BASE_MS,
      signal: input.signal,
      onRetry: (attempt, maxRetries, reason) => {
        input.onEvent?.({ type: "retry", provider: "openai", attempt, maxRetries, reason });
      },
      shouldRetry: (err) => (err as RetryableError).retryable === true || isRetryableNetworkError(err),
      run: async () => {
        input.onEvent?.({ type: "status", provider: "openai", phase: "auth", message: "auth: openai-codex" });
        input.onEvent?.({ type: "status", provider: "openai", phase: "request", message: "requesting" });

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: createRequestSignal(input.signal, TIMEOUT_MS),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          let message = text || response.statusText;
          let code: string | undefined;
          const parsed = parseJson(text);
          if (parsed && typeof parsed === "object") {
            const error = (parsed as { error?: { message?: unknown; code?: unknown } }).error;
            if (typeof error?.message === "string") message = error.message;
            if (typeof error?.code === "string") code = error.code;
          }
          const err = new Error(`OpenAI API error (${response.status}): ${message}`) as RetryableError;
          err.retryable = isRetryableStatus(response.status) || code === "rate_limit_exceeded";
          throw err;
        }

        if (!response.body) throw new Error("OpenAI returned no stream body");

        const reader = response.body.getReader();
        let text = "";
        let model: string | undefined;
        const sourceMap = new Map<string, string | undefined>();
        let lastRender = 0;

        await consumeSseJson({
          reader,
          onPayload: async (raw) => {
            const evt = streamEventSchema.safeParse(raw);
            if (!evt.success) return;
            const event = evt.data;

            if (event.type === "response.created") {
              const h = event.response?.headers;
              if (h) {
                const m = h["openai-model"] ?? h["OpenAI-Model"];
                if (typeof m === "string") model = m;
              }
              return;
            }

            if (event.type === "response.output_text.delta" && event.delta) {
              text += event.delta;
              const now = Date.now();
              if (now - lastRender > 200) {
                input.onEvent?.({ type: "partial", provider: "openai", text });
                input.onEvent?.({ type: "status", provider: "openai", phase: "streaming", message: "streaming" });
                lastRender = now;
              }
              return;
            }

            if (event.type === "response.output_item.done" && event.item) {
              const item = messageItemSchema.safeParse(event.item);
              if (item.success) {
                const snapshot = item.data.content
                  .filter((c) => c.type === "output_text" && typeof c.text === "string")
                  .map((c) => c.text!)
                  .join("");
                if (snapshot) text = snapshot;
                for (const part of item.data.content) {
                  for (const ann of part.annotations ?? []) {
                    if (ann.type === "url_citation" && ann.url && !sourceMap.has(ann.url)) {
                      sourceMap.set(ann.url, ann.title);
                    }
                  }
                }
              }

              const ws = webSearchItemSchema.safeParse(event.item);
              if (ws.success && ws.data.action) {
                input.onEvent?.({ type: "status", provider: "openai", phase: "streaming", message: ws.data.action.type });
              }
              return;
            }

            if (event.type === "response.failed") {
              const e = event.response?.error;
              const err = new Error(`OpenAI API error: ${e?.message || e?.code || "unknown"}`) as RetryableError;
              err.retryable = e?.code === "rate_limit_exceeded" || e?.code === "server_is_overloaded" || e?.code === "slow_down";
              throw err;
            }

            if (event.type === "response.incomplete") {
              throw new Error(`Incomplete response: ${event.response?.incomplete_details?.reason || "unknown"}`);
            }
          },
        });

        const finalText = text.trim();
        if (!finalText) throw new Error("OpenAI returned no text content");

        return {
          provider: "openai",
          text: finalText,
          model,
          sources: Array.from(sourceMap.entries()).map(([url, title]) => ({ url, title })),
        };
      },
    });
  },
};

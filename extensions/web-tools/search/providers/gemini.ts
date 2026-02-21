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

const PROVIDER = "google-gemini-cli";
const BASE_URL = "https://cloudcode-pa.googleapis.com";
const MODEL = "gemini-2.5-flash";
const TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1_000;
const REDIRECT_RESOLVE_TIMEOUT_MS = 8_000;
const GROUNDING_REDIRECT_HOST = "vertexaisearch.cloud.google.com";

const credentialsSchema = z.object({
  token: z.string().min(1),
  projectId: z.string().min(1),
});

const credentialsJsonSchema = z
  .string()
  .transform((value, ctx) => {
    try {
      return JSON.parse(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid_json" });
      return z.NEVER;
    }
  })
  .pipe(credentialsSchema);

const candidateSchema = z
  .object({
    content: z.object({ parts: z.array(z.object({ text: z.string().optional() }).passthrough()).optional() }).optional(),
    groundingMetadata: z
      .object({
        groundingChunks: z
          .array(
            z
              .object({
                web: z.object({ title: z.string().optional(), uri: z.string().optional() }).optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .optional(),
  })
  .passthrough();

const payloadSchema = z
  .object({
    response: z.object({ candidates: z.array(candidateSchema).optional() }).passthrough().optional(),
    candidates: z.array(candidateSchema).optional(),
  })
  .passthrough();

type RetryableError = Error & { retryable?: boolean };

function parsePayload(value: unknown): z.infer<typeof payloadSchema> | null {
  const parsed = payloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseErrorMessage(bodyText: string): string {
  const parsed = parseJson(bodyText);
  if (parsed && typeof parsed === "object") {
    const msg = (parsed as { error?: { message?: unknown } }).error?.message;
    if (typeof msg === "string") return msg;
  }
  return bodyText;
}

async function resolveSourceUrl(url: string, signal?: AbortSignal): Promise<string> {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== GROUNDING_REDIRECT_HOST) return url;
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: createRequestSignal(signal, REDIRECT_RESOLVE_TIMEOUT_MS),
    });
    return response.url || url;
  } catch {
    return url;
  }
}

export const geminiProvider: SearchProvider = {
  id: "gemini",
  async isAvailable(ctx: ExtensionContext): Promise<boolean> {
    const raw = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
    if (!raw) return false;
    return credentialsJsonSchema.safeParse(raw).success;
  },
  async run(ctx: ExtensionContext, input) {
    const query = input.query.trim();
    if (!query) throw new Error("query cannot be empty");

    const raw = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
    if (!raw) throw new Error("google-gemini-cli not authenticated");
    const creds = credentialsJsonSchema.safeParse(raw);
    if (!creds.success) throw new Error("google-gemini-cli credentials invalid");

    const found = ctx.modelRegistry.find(PROVIDER, MODEL);
    const model = found?.id || MODEL;
    const providerBaseUrl = (found && typeof found.baseUrl === "string" ? found.baseUrl : BASE_URL).replace(/\/+$/, "");

    const body = {
      project: creds.data.projectId,
      model,
      request: {
        contents: [{ role: "user", parts: [{ text: `Search the web for: ${query}\nProvide a concise, factual answer in markdown. Include key points only.` }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: { temperature: 0.2 },
      },
      userAgent: "search-extension",
      requestId: `search-${Date.now()}`,
    };

    const headers = {
      Authorization: `Bearer ${creds.data.token}`,
      "Content-Type": "application/json",
      "User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
      "X-Goog-Api-Client": "gl-node/22.17.0",
      "Client-Metadata": JSON.stringify({
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      }),
      Accept: "text/event-stream",
    };

    return withExponentialRetries({
      maxRetries: MAX_RETRIES,
      baseDelayMs: RETRY_BASE_MS,
      signal: input.signal,
      onRetry: (attempt, maxRetries, reason) => {
        input.onEvent?.({ type: "retry", provider: "gemini", attempt, maxRetries, reason });
      },
      shouldRetry: (err) => (err as RetryableError).retryable === true || isRetryableNetworkError(err),
      run: async () => {
        input.onEvent?.({ type: "status", provider: "gemini", phase: "auth", message: "auth: google-gemini-cli" });
        input.onEvent?.({ type: "status", provider: "gemini", phase: "request", message: "requesting" });

        const response = await fetch(`${providerBaseUrl}/v1internal:streamGenerateContent?alt=sse`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: createRequestSignal(input.signal, TIMEOUT_MS),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          const err = new Error(`Gemini API error (${response.status}): ${parseErrorMessage(text)}`) as RetryableError;
          err.retryable = isRetryableStatus(response.status);
          throw err;
        }

        if (!response.body) throw new Error("Gemini returned no stream body");

        const reader = response.body.getReader();
        let latestText = "";
        let lastRender = 0;
        const sourceMap = new Map<string, string | undefined>();

        await consumeSseJson({
          reader,
          onPayload: async (rawPayload) => {
            const payload = parsePayload(rawPayload);
            if (!payload) return;
            const candidate = payload.response?.candidates?.[0] ?? payload.candidates?.[0];
            if (!candidate) return;

            const chunkText = (candidate.content?.parts ?? [])
              .flatMap((part) => (typeof part.text === "string" ? [part.text] : []))
              .join("");
            if (chunkText) {
              if (!latestText) {
                latestText = chunkText;
              } else if (chunkText.startsWith(latestText)) {
                latestText = chunkText;
              } else {
                latestText += chunkText;
              }

              const now = Date.now();
              if (now - lastRender > 200) {
                input.onEvent?.({ type: "partial", provider: "gemini", text: latestText });
                input.onEvent?.({ type: "status", provider: "gemini", phase: "streaming", message: "streaming" });
                lastRender = now;
              }
            }

            for (const chunk of candidate.groundingMetadata?.groundingChunks ?? []) {
              const uri = chunk.web?.uri;
              if (!uri || sourceMap.has(uri)) continue;
              sourceMap.set(uri, chunk.web?.title);
            }
          },
        });

        const text = latestText.trim();
        if (!text) throw new Error("Gemini returned no text content");

        const resolvedSources = await Promise.all(
          Array.from(sourceMap.entries()).map(async ([url, title]) => ({
            url: await resolveSourceUrl(url, input.signal),
            title,
          })),
        );

        const dedupedSources = new Map<string, string | undefined>();
        for (const source of resolvedSources) {
          if (!dedupedSources.has(source.url)) dedupedSources.set(source.url, source.title);
        }

        return {
          provider: "gemini",
          text,
          model,
          sources: Array.from(dedupedSources.entries()).map(([url, title]) => ({ url, title })),
        };
      },
    });
  },
};

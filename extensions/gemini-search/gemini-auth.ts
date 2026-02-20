import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  CredentialsJsonSchema,
  extractGoogleRpcErrorMessage,
  parseCloudCodeAssistPayload,
  type Candidate,
  type GeminiSubscriptionCredentials,
} from "./gemini-schemas";
import {
  buildResultFromCandidate,
  formatSources,
  type CloudCodeAssistResponse,
  type Source,
  type UrlRetrievalStatus,
} from "./gemini-response";

export const GOOGLE_GEMINI_CLI_PROVIDER = "google-gemini-cli";
const DEFAULT_BASE_URL = "https://cloudcode-pa.googleapis.com";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;

type GeminiCliModel = {
  id: string;
  provider: string;
  baseUrl?: string;
};

export type { GeminiSubscriptionCredentials };
export type { Source, UrlRetrievalStatus, CloudCodeAssistResponse };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isGeminiCliModel(model: unknown): model is GeminiCliModel {
  if (!isRecord(model)) return false;
  return typeof model.id === "string" && typeof model.provider === "string";
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /aborted/i.test(error.message);
}

function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("other side closed") ||
    msg.includes("resource exhausted") ||
    msg.includes("rate limit") ||
    msg.includes("service unavailable")
  );
}

function getRetryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
  }
  return DEFAULT_RETRY_BASE_DELAY_MS * 2 ** attempt;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }

  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Request aborted"));
      return;
    }

    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Request aborted"));
    };

    signal.addEventListener("abort", onAbort);
  });
}

function extractErrorMessageFromBody(bodyText: string): string {
  return extractGoogleRpcErrorMessage(bodyText);
}

function compactReason(reason: string, max = 140): string {
  const s = reason.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  maxRetries = DEFAULT_MAX_RETRIES,
  onRetry?: (attempt: number, maxRetries: number, reason?: string) => void,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal });
      if (response.ok) return response;

      if (!isRetryableStatus(response.status) || attempt === maxRetries) {
        return response;
      }

      const retryBodyText = await response.text().catch(() => "");
      const retryReason = compactReason(
        `HTTP ${response.status}${retryBodyText ? `: ${extractErrorMessageFromBody(retryBodyText)}` : ""}`,
      );
      onRetry?.(attempt + 1, maxRetries, retryReason);
      const delayMs = getRetryDelayMs(response, attempt);
      await sleep(delayMs, signal);
      continue;
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = error;
      if (!isRetryableFetchError(error)) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      if (attempt === maxRetries) break;
      onRetry?.(attempt + 1, maxRetries, compactReason(asErrorMessage(error)));
      const delayMs = DEFAULT_RETRY_BASE_DELAY_MS * 2 ** attempt;
      await sleep(delayMs, signal);
    }
  }

  throw new Error(`Request failed after retries: ${asErrorMessage(lastError)}`);
}

export async function getGeminiSubscriptionCredentials(
  ctx: ExtensionContext,
): Promise<GeminiSubscriptionCredentials> {
  const raw = await ctx.modelRegistry.getApiKeyForProvider(GOOGLE_GEMINI_CLI_PROVIDER);
  if (!raw) {
    throw new Error(
      "No google-gemini-cli credentials found. Run /login gemini first.",
    );
  }

  const validated = CredentialsJsonSchema.safeParse(raw);
  if (!validated.success) {
    const invalidJson = validated.error.issues.some((issue) => issue.message === "invalid_json");
    if (invalidJson) {
      throw new Error(
        "google-gemini-cli credentials are not valid JSON. Please /logout and /login gemini again.",
      );
    }

    throw new Error(
      "google-gemini-cli credentials are missing token/projectId. Please /logout and /login gemini again.",
    );
  }

  return validated.data;
}

export function pickGeminiCliModel(ctx: ExtensionContext): GeminiCliModel {
  const preferred = [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-3-flash-preview",
    "gemini-3-pro-preview",
    "gemini-2.0-flash",
  ];

  for (const id of preferred) {
    const found = ctx.modelRegistry.find(GOOGLE_GEMINI_CLI_PROVIDER, id);
    if (found && isGeminiCliModel(found)) return found;
  }

  const available = ctx.modelRegistry.getAvailable();
  const fallback = available.find((m) => m.provider === GOOGLE_GEMINI_CLI_PROVIDER);
  if (!fallback || !isGeminiCliModel(fallback)) {
    throw new Error(
      "No models available for provider google-gemini-cli. Check /login gemini and /model.",
    );
  }

  return fallback;
}


async function readSseChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  timeoutMs = 20_000,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    if (combined.aborted) {
      reject(new Error("SSE read timed out"));
      return;
    }

    const onAbort = () => {
      combined.removeEventListener("abort", onAbort);
      reject(new Error("SSE read timed out"));
    };

    combined.addEventListener("abort", onAbort);
    reader
      .read()
      .then((result) => {
        combined.removeEventListener("abort", onAbort);
        resolve(result);
      })
      .catch((error) => {
        combined.removeEventListener("abort", onAbort);
        reject(error);
      });
  });
}

function createRequestOptions(options: {
  ctx: ExtensionContext;
  signal?: AbortSignal;
  prompt: string;
  tool: "googleSearch" | "urlContext";
  timeoutMs?: number;
}) {
  const { ctx, signal, prompt, tool } = options;
  const model = pickGeminiCliModel(ctx);

  return getGeminiSubscriptionCredentials(ctx).then((creds) => {
    const baseUrl = (model.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const body = {
      project: creds.projectId,
      model: model.id,
      request: {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ [tool]: {} }],
        generationConfig: {
          temperature: 0.2,
        },
      },
      userAgent: "pi-gemini-fetch",
      requestId: `pi-gemini-fetch-${Date.now()}`,
    };

    const headers = {
      Authorization: `Bearer ${creds.token}`,
      "Content-Type": "application/json",
      "User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
      "X-Goog-Api-Client": "gl-node/22.17.0",
      "Client-Metadata": JSON.stringify({
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      }),
    };

    return { baseUrl, body, headers, requestSignal };
  });
}

export async function runCloudCodeAssistPrompt(options: {
  ctx: ExtensionContext;
  signal?: AbortSignal;
  prompt: string;
  tool: "googleSearch" | "urlContext";
  timeoutMs?: number;
  maxRetries?: number;
  onRetry?: (attempt: number, maxRetries: number, reason?: string) => void;
}): Promise<CloudCodeAssistResponse> {
  const req = await createRequestOptions(options);
  const url = `${req.baseUrl}/v1internal:generateContent`;

  const response = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
    },
    req.requestSignal,
    options.maxRetries ?? DEFAULT_MAX_RETRIES,
    options.onRetry,
  );

  if (!response.ok) {
    const text = await response.text();
    const parsed = extractErrorMessageFromBody(text);
    throw new Error(`Cloud Code Assist API error (${response.status}): ${parsed || response.statusText}`);
  }

  const json: unknown = await response.json();
  const payload = parseCloudCodeAssistPayload(json);
  return buildResultFromCandidate(payload.candidates?.[0], json, req.requestSignal);
}

export async function runCloudCodeAssistPromptStream(options: {
  ctx: ExtensionContext;
  signal?: AbortSignal;
  prompt: string;
  tool: "googleSearch" | "urlContext";
  timeoutMs?: number;
  maxRetries?: number;
  onRetry?: (attempt: number, maxRetries: number, reason?: string) => void;
  onTextDelta?: (delta: string, accumulated: string) => void;
}): Promise<CloudCodeAssistResponse> {
  const req = await createRequestOptions(options);
  const url = `${req.baseUrl}/v1internal:streamGenerateContent?alt=sse`;

  const response = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        ...req.headers,
        Accept: "text/event-stream",
      },
      body: JSON.stringify(req.body),
    },
    req.requestSignal,
    options.maxRetries ?? DEFAULT_MAX_RETRIES,
    options.onRetry,
  );

  if (!response.ok) {
    const text = await response.text();
    const parsed = extractErrorMessageFromBody(text);
    throw new Error(`Cloud Code Assist API error (${response.status}): ${parsed || response.statusText}`);
  }

  if (!response.body) {
    throw new Error("Cloud Code Assist streaming response did not include a body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let accumulated = "";
  let latestSnapshot = "";
  let latestRaw: unknown = undefined;
  let latestCandidate: Candidate | undefined;

  const abortHandler = () => {
    void reader.cancel().catch(() => {});
  };
  req.requestSignal.addEventListener("abort", abortHandler);

  try {
    while (true) {
      const { done, value } = await readSseChunkWithTimeout(reader, req.requestSignal);
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          continue;
        }

        latestRaw = parsed;
        const payload = parseCloudCodeAssistPayload(parsed);
        const candidate = payload.candidates?.[0];
        if (!candidate) continue;
        latestCandidate = candidate;

        const parts = candidate.content?.parts ?? [];
        const snapshot = parts
          .flatMap((part) => (typeof part.text === "string" ? [part.text] : []))
          .join("");

        if (!snapshot) continue;

        let delta = snapshot;
        if (latestSnapshot && snapshot.startsWith(latestSnapshot)) {
          delta = snapshot.slice(latestSnapshot.length);
        }

        latestSnapshot = snapshot;
        if (!delta) continue;

        accumulated += delta;
        options.onTextDelta?.(delta, accumulated);
      }
    }
  } finally {
    req.requestSignal.removeEventListener("abort", abortHandler);
  }

  let result = await buildResultFromCandidate(latestCandidate, latestRaw, req.requestSignal);

  const accumulatedTrimmed = accumulated.trim();
  const modelTrimmed = result.modelText.trim();
  if (accumulatedTrimmed) {
    const clearlyMoreComplete =
      !modelTrimmed ||
      accumulatedTrimmed.length > modelTrimmed.length + 80 ||
      (modelTrimmed.length > 0 && accumulatedTrimmed.endsWith(modelTrimmed));

    if (clearlyMoreComplete) {
      result = {
        ...result,
        modelText: accumulatedTrimmed,
        text: accumulatedTrimmed,
      };
    }
  }

  if (!result.text.trim()) {
    throw new Error("Cloud Code Assist streaming response contained no text");
  }
  return result;
}

export { formatSources };

export function safeErrorMessage(error: unknown): string {
  return asErrorMessage(error);
}

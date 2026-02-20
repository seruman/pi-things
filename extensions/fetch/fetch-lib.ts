import { Type } from "@sinclair/typebox";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { runLightpandaFetch } from "./lightpanda";

export type FetchRecord = {
  url: string;
  title: string;
  content: string;
  error: string | null;
};

export type StoredFetchResult = {
  id: string;
  createdAt: number;
  urls: FetchRecord[];
};

export type FetchDetails = {
  phase?: string;
  progress?: number;
  responseId?: string;
  urlCount?: number;
  successful?: number;
  title?: string;
  totalChars?: number;
  urls?: string[];
  truncated?: boolean;
  durationMs?: number;
  error?: string;
};

export type GetFetchDetails = {
  error?: string;
  responseId?: string;
  url?: string;
  title?: string;
  contentLength?: number;
};

export const MAX_INLINE_CONTENT = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const STORE_TTL_MS = 60 * 60 * 1000;
const MAX_STORED_RESULTS = 200;

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
const store = new Map<string, StoredFetchResult>();

export const fetchParams = Type.Object({
  url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
  urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs to fetch" })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 120000, description: "Request timeout in ms" })),
});

export const getFetchParams = Type.Object({
  responseId: Type.String({ description: "responseId from fetch_content" }),
  url: Type.Optional(Type.String({ description: "Get content for this URL" })),
  urlIndex: Type.Optional(Type.Number({ description: "Get content for URL at index" })),
});

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fallbackTitle(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop();
    return seg || u.hostname || url;
  } catch {
    return url;
  }
}

function ensureHttpUrl(input: string): string {
  const parsed = new URL(input);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http/https URLs are supported: ${input}`);
  }
  return parsed.toString();
}

function titleFromMarkdown(markdown: string, url: string): string {
  const lines = markdown.split("\n");
  for (const line of lines) {
    const t = line.trim();
    if (t.toLowerCase().startsWith("title:")) {
      const v = t.slice(6).trim();
      if (v) return v;
    }
  }
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("# ")) return t.slice(2).trim() || fallbackTitle(url);
  }
  return fallbackTitle(url);
}

function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 1000).toLowerCase();
  return head.includes("<!doctype html") || head.includes("<html") || head.includes("<body") || head.includes("<head");
}

function looksLikeMarkdown(text: string): boolean {
  const head = text.slice(0, 1000);
  return /^\s*#\s+\S+/m.test(head) || /^\s*[-*]\s+\S+/m.test(head) || /^\s*```/m.test(head) || /^\s*---\n/m.test(head);
}

function extractContent(target: string, raw: string, contentType?: string): FetchRecord {
  const normalizedType = (contentType || "").toLowerCase();

  if (normalizedType.includes("text/markdown") || (!normalizedType && looksLikeMarkdown(raw) && !looksLikeHtml(raw))) {
    return {
      url: target,
      title: titleFromMarkdown(raw, target),
      content: raw,
      error: null,
    };
  }

  if (normalizedType.startsWith("text/plain")) {
    return {
      url: target,
      title: fallbackTitle(target),
      content: raw,
      error: null,
    };
  }

  if (normalizedType.includes("text/html") || normalizedType.includes("application/xhtml+xml") || normalizedType === "" || looksLikeHtml(raw)) {
    const { document } = parseHTML(raw);
    const reader = new Readability(document);
    const article = reader.parse();

    if (article?.content) {
      const markdown = turndown.turndown(article.content).trim();
      return {
        url: target,
        title: article.title?.trim() || fallbackTitle(target),
        content: markdown || raw,
        error: null,
      };
    }
  }

  return {
    url: target,
    title: fallbackTitle(target),
    content: raw,
    error: null,
  };
}

export function pruneStore(now = Date.now()): void {
  for (const [id, entry] of store) {
    if (now - entry.createdAt > STORE_TTL_MS) {
      store.delete(id);
    }
  }

  while (store.size > MAX_STORED_RESULTS) {
    const oldestKey = store.keys().next().value;
    if (typeof oldestKey !== "string") break;
    store.delete(oldestKey);
  }
}

export function putStoredFetch(result: StoredFetchResult): void {
  store.set(result.id, result);
}

export function getStoredFetch(responseId: string): StoredFetchResult | undefined {
  return store.get(responseId);
}

export function summarizeFetchResults(results: FetchRecord[], responseId: string): string {
  let summary = "## Fetched URLs\n\n";
  for (const r of results) {
    summary += r.error
      ? `- ${r.url}: Error - ${r.error}\n`
      : `- ${r.title || r.url} (${r.content.length} chars)\n`;
  }
  summary += `\n---\nUse get_fetch_content({ responseId: \"${responseId}\", urlIndex: 0 }) to retrieve full content.`;
  return summary;
}

export async function fetchOne(url: string, signal: AbortSignal | undefined, timeoutMs = 30_000): Promise<FetchRecord> {
  const target = ensureHttpUrl(url.trim());

  const lpRaw = await runLightpandaFetch(target, timeoutMs, signal);
  if (lpRaw && lpRaw.length <= MAX_RESPONSE_BYTES) {
    return extractContent(target, lpRaw);
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  try {
    const response = await fetch(target, {
      signal: requestSignal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/markdown, text/plain;q=0.95, text/html;q=0.9, application/xhtml+xml;q=0.85, application/json;q=0.8, */*;q=0.5",
      },
    });

    if (!response.ok) {
      return { url: target, title: fallbackTitle(target), content: "", error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const contentLength = Number(response.headers.get("content-length") || "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      return {
        url: target,
        title: fallbackTitle(target),
        content: "",
        error: `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`,
      };
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_BYTES) {
      return {
        url: target,
        title: fallbackTitle(target),
        content: "",
        error: `Response too large (${Math.round(raw.length / 1024 / 1024)}MB)`,
      };
    }

    return extractContent(target, raw, contentType);
  } catch (error) {
    return {
      url: target,
      title: fallbackTitle(target),
      content: "",
      error: normalizeError(error),
    };
  }
}

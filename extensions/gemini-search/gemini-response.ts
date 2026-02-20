import type { Candidate, GroundingChunk, GroundingSupport } from "./gemini-schemas";

export type Source = { title: string; uri: string };

export type UrlRetrievalStatus =
  | "URL_RETRIEVAL_STATUS_SUCCESS"
  | "URL_RETRIEVAL_STATUS_UNSAFE"
  | "URL_RETRIEVAL_STATUS_ERROR"
  | "URL_RETRIEVAL_STATUS_UNSPECIFIED"
  | string;

export type CloudCodeAssistResponse = {
  text: string;
  modelText: string;
  raw: unknown;
  sources: Source[];
  urlStatuses: UrlRetrievalStatus[];
};

function applyGroundingCitations(text: string, _supports: GroundingSupport[] | undefined): string {
  // Keep model text as-is for stability (pi-web-access style):
  // no inline byte-index citation insertion; sources are provided separately.
  return text;
}

function isGroundingRedirectUrl(url: string): boolean {
  return url.includes("vertexaisearch.cloud.google.com/grounding-api-redirect/");
}

async function resolveGroundingRedirectUrl(url: string, signal?: AbortSignal): Promise<string> {
  if (!isGroundingRedirectUrl(url)) return url;

  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
    });

    const location = response.headers.get("location");
    return location || url;
  } catch {
    return url;
  }
}

async function extractSources(groundingChunks: GroundingChunk[] | undefined, signal?: AbortSignal): Promise<Source[]> {
  const chunks = groundingChunks ?? [];
  const resolved = await Promise.all(
    chunks.map(async (chunk) => {
      const title = chunk?.web?.title ?? "Untitled";
      const uri = chunk?.web?.uri ?? "";
      if (!uri) return null;
      const canonicalUri = await resolveGroundingRedirectUrl(uri, signal);
      return { title, uri: canonicalUri } satisfies Source;
    }),
  );

  return resolved.filter((s): s is Source => Boolean(s));
}

function extractUrlStatuses(candidate: Candidate | undefined): UrlRetrievalStatus[] {
  const statuses: UrlRetrievalStatus[] = [];

  const camel = candidate?.urlContextMetadata?.urlMetadata ?? [];
  for (const item of camel) {
    if (item.urlRetrievalStatus) statuses.push(item.urlRetrievalStatus);
  }

  const snake = candidate?.url_context_metadata?.url_metadata ?? [];
  for (const item of snake) {
    if (item.url_retrieval_status) statuses.push(item.url_retrieval_status);
  }

  return statuses;
}

export async function buildResultFromCandidate(
  candidate: Candidate | undefined,
  raw: unknown,
  signal?: AbortSignal,
): Promise<CloudCodeAssistResponse> {
  const parts = candidate?.content?.parts ?? [];
  const plainText = parts
    .flatMap((p) => (typeof p?.text === "string" ? [p.text] : []))
    .join("\n")
    .trim();

  const groundingChunks = candidate?.groundingMetadata?.groundingChunks;
  const groundingSupports = candidate?.groundingMetadata?.groundingSupports;
  const text = applyGroundingCitations(plainText, groundingSupports);
  const sources = await extractSources(groundingChunks, signal);
  const urlStatuses = extractUrlStatuses(candidate);

  return {
    text,
    modelText: plainText,
    raw,
    sources,
    urlStatuses,
  };
}

export function formatSources(sources: Source[]): string {
  if (!sources.length) return "";

  const unique = new Map<string, string>();
  for (const source of sources) {
    if (!unique.has(source.uri)) unique.set(source.uri, source.title);
  }

  const lines = Array.from(unique.entries()).map(([uri, title]) => {
    let host = "";
    try {
      host = new URL(uri).hostname;
    } catch {
      host = "";
    }

    const safeTitle = title.replace(/\]/g, "\\]");
    return host
      ? `- [${safeTitle}](${uri}) _(${host})_`
      : `- [${safeTitle}](${uri})`;
  });

  return `\n\n## Sources\n${lines.join("\n")}`;
}

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  fetchOne,
  fetchParams,
  generateId,
  getFetchParams,
  getStoredFetch,
  MAX_INLINE_CONTENT,
  pruneStore,
  putStoredFetch,
  summarizeFetchResults,
  type FetchRecord,
  type FetchDetails,
  type GetFetchDetails,
} from "./fetch-lib";
import {
  renderFetchCall,
  renderFetchResult,
  renderGetFetchCall,
  renderGetFetchResult,
} from "./fetch-ui";

export default function (pi: ExtensionAPI) {
  pi.registerTool<typeof fetchParams, FetchDetails>({
    name: "fetch_content",
    label: "Fetch Content",
    description: "Fetch URL(s) and extract readable content locally. Tries Lightpanda first, falls back to HTTP fetch (prefers markdown/text via Accept negotiation), then HTML extraction. Stores content in memory and returns responseId for indexed retrieval.",
    parameters: fetchParams,
    async execute(_toolCallId, params, signal, onUpdate, _ctx: ExtensionContext) {
      pruneStore();
      const urls = params.urls ?? (params.url ? [params.url] : []);
      if (urls.length === 0) {
        return {
          content: [{ type: "text", text: "Error: No URL provided." }],
          isError: true,
          details: { error: "No URL provided" },
        };
      }

      onUpdate?.({ content: [{ type: "text", text: `Fetching ${urls.length} URL(s)...` }], details: { phase: "fetch", progress: 0 } });

      const startedAt = Date.now();
      const timeoutMs = params.timeoutMs ?? 30_000;
      const results: FetchRecord[] = [];
      for (let i = 0; i < urls.length; i++) {
        onUpdate?.({
          content: [{ type: "text", text: `Fetching ${i + 1}/${urls.length}: ${urls[i]}` }],
          details: { phase: "fetch", progress: i / urls.length },
        });

        const res = await fetchOne(urls[i], signal, timeoutMs);
        results.push(res);
        onUpdate?.({
          content: [{ type: "text", text: `Fetched ${i + 1}/${urls.length}` }],
          details: { phase: "fetch", progress: (i + 1) / urls.length },
        });
      }

      const responseId = generateId();
      putStoredFetch({ id: responseId, createdAt: Date.now(), urls: results });
      pruneStore();

      const successful = results.filter((r) => !r.error).length;
      const durationMs = Date.now() - startedAt;

      if (urls.length === 1) {
        const r = results[0];
        if (r.error) {
          return {
            content: [{ type: "text", text: `Error: ${r.error}` }],
            isError: true,
            details: { error: r.error, responseId, urlCount: 1, successful: 0, durationMs },
          };
        }

        const truncated = r.content.length > MAX_INLINE_CONTENT;
        let output = truncated ? r.content.slice(0, MAX_INLINE_CONTENT) : r.content;
        if (truncated) output += "\n\n[Content truncated...]";
        output += `\n\n---\nresponseId: ${responseId}\nUse get_fetch_content({ responseId: \"${responseId}\", urlIndex: 0 }) for stored content.`;

        return {
          content: [{ type: "text", text: output }],
          details: {
            responseId,
            title: r.title,
            totalChars: r.content.length,
            urlCount: 1,
            successful: 1,
            truncated,
            urls: [r.url],
            durationMs,
          },
        };
      }

      return {
        content: [{ type: "text", text: summarizeFetchResults(results, responseId) }],
        details: { responseId, urlCount: urls.length, successful, urls: results.map((r) => r.url), durationMs },
      };
    },
    renderCall(args, theme) {
      return renderFetchCall(args, theme);
    },
    renderResult(result, opts, theme) {
      return renderFetchResult(result, opts, theme);
    },
  });

  pi.registerTool<typeof getFetchParams, GetFetchDetails>({
    name: "get_fetch_content",
    label: "Get Fetch Content",
    description: "Retrieve full content from a previous fetch_content call by responseId and url/urlIndex (in-memory, may expire).",
    parameters: getFetchParams,
    async execute(_toolCallId, params) {
      pruneStore();
      const data = getStoredFetch(params.responseId);
      if (!data) {
        return {
          content: [{ type: "text", text: `Error: No stored result for \"${params.responseId}\" (expired or evicted). Re-run fetch_content.` }],
          isError: true,
          details: { error: "Not found", responseId: params.responseId },
        };
      }

      let record: FetchRecord | undefined;
      if (params.url !== undefined) {
        record = data.urls.find((u) => u.url === params.url);
      } else if (params.urlIndex !== undefined) {
        record = data.urls[params.urlIndex];
      } else {
        const list = data.urls.map((u, i) => `${i}: ${u.url}`).join("\n");
        return {
          content: [{ type: "text", text: `Specify url or urlIndex. Available:\n${list}` }],
          isError: true,
          details: { error: "No URL selector provided", responseId: params.responseId },
        };
      }

      if (!record) {
        return {
          content: [{ type: "text", text: "Error: URL not found in stored result." }],
          isError: true,
          details: { error: "URL not found", responseId: params.responseId },
        };
      }

      if (record.error) {
        return {
          content: [{ type: "text", text: `Error: ${record.error}` }],
          isError: true,
          details: { error: record.error, responseId: params.responseId, url: record.url },
        };
      }

      return {
        content: [{ type: "text", text: record.content }],
        details: {
          responseId: params.responseId,
          url: record.url,
          title: record.title,
          contentLength: record.content.length,
        },
      };
    },
    renderCall(args, theme) {
      const responseId = typeof args.responseId === "string" ? args.responseId : "";
      const url = typeof args.url === "string" ? args.url : undefined;
      const urlIndex = typeof args.urlIndex === "number" ? args.urlIndex : undefined;
      return renderGetFetchCall({ responseId, url, urlIndex }, theme);
    },
    renderResult(result, opts, theme) {
      return renderGetFetchResult(result, opts, theme);
    },
  });
}

# fetch

Local browser-backed fetch extension. Extracts readable content from URLs.

## Tools

### `fetch_content`

Fetch one or more URLs and extract readable content.

```
fetch_content({
  url?: string,            // single URL to fetch
  urls?: string[],         // multiple URLs to fetch
  timeoutMs?: number,      // request timeout in ms (1000–120000, default 30000)
})
```

- Tries Lightpanda first, falls back to HTTP fetch (prefers `text/markdown` / `text/plain` via Accept), then HTML extraction with Readability
- Stores full content in memory, returns truncated inline preview + `responseId`
- For multi-URL fetches, returns a summary table with per-URL status

### `get_fetch_content`

Retrieve full stored content from a previous `fetch_content` call.

```
get_fetch_content({
  responseId: string,      // responseId from fetch_content result
  url?: string,            // get content for this specific URL
  urlIndex?: number,       // or get content by index
})
```

- In-memory store; entries may expire or get evicted
- If expired, re-run `fetch_content`

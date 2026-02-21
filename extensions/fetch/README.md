# fetch

Fetch web content with two explicit modes: regular HTTP and rendered/browser fetch.

## Tools

### `fetch_content`

Fetch a URL via regular HTTP and extract readable content.

```ts
fetch_content({
  url: string,
  format?: "auto" | "markdown" | "text" | "html", // default: "auto"
  timeoutMs?: number,                             // 1000–120000, default: 30000
})
```

Behavior:
- Uses standard HTTP fetch
- Negotiates content type with `Accept` headers
- Extracts readable output from HTML (Readability + Turndown)
- No caching/state between calls

### `fetch_rendered`

Fetch a URL through browser rendering (Lightpanda) and extract readable content.

```ts
fetch_rendered({
  url: string,
  format?: "auto" | "markdown" | "text" | "html", // default: "auto"
  timeoutMs?: number,                             // 1000–120000, default: 30000
})
```

Behavior:
- Uses rendered/browser fetch path for JS-heavy pages
- Applies the same output formatting options as `fetch_content`
- No caching/state between calls

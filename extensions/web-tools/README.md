# web-tools

Unified web extension for search and fetch tooling.

## Tools

### `web_search`

Search the web with provider fallback.

```ts
web_search({
  query: string,
  providers?: ("gemini" | "openai")[],
  live?: boolean,
  debug?: boolean,
})
```

### `web_fetch`

Fetch URL content via regular HTTP.

```ts
web_fetch({
  url: string,
  format?: "auto" | "markdown" | "text" | "html",
  timeoutMs?: number,
})
```

### `web_fetch_rendered`

Fetch URL content via rendered/browser path (Lightpanda).

```ts
web_fetch_rendered({
  url: string,
  format?: "auto" | "markdown" | "text" | "html",
  timeoutMs?: number,
})
```
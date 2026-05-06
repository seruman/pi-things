# web-tools

Personal web tools for pi.

## Tools

### `web_search`

Brave Search only.

Requirements:

- Set `BRAVE_SEARCH_API_KEY` or `BRAVE_API_KEY`.

```ts
web_search({
  query: string,
  count?: number,                 // 1..20, default 5
  offset?: number,                // 0..9
  country?: string,               // default "US"
  freshness?: string,             // pd|pw|pm|py|YYYY-MM-DDtoYYYY-MM-DD
  searchLang?: string,
  uiLang?: string,
  safesearch?: "off" | "moderate" | "strict",
  extraSnippets?: boolean,
  goggles?: string[],
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
  perUrlMaxChars?: number,        // default 3000
})
```

### `web_fetch_rendered`

Fetch URL content via Lightpanda.

Requirements:

- `lightpanda` installed and available in `PATH`.

```ts
web_fetch_rendered({
  url: string,
  format?: "auto" | "markdown" | "text" | "html",
  timeoutMs?: number,
  perUrlMaxChars?: number,        // default 3000
})
```

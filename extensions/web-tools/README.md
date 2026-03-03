# web-tools

Unified web extension for search and fetch tooling.

## Tools

### `web_search`

Primary web search using Brave Search API.

**Requirements**

- `BRAVE_API_KEY` environment variable set.

```ts
web_search({
  query: string,
  count?: number,                 // 1..20 (default 5)
  offset?: number,                // 0..9
  country?: string,               // default: "US"
  freshness?: string,             // pd|pw|pm|py|YYYY-MM-DDtoYYYY-MM-DD
  searchLang?: string,
  uiLang?: string,
  safesearch?: "off" | "moderate" | "strict",
  extraSnippets?: boolean,
  goggles?: string[],
  debug?: boolean,
})
```

### `web_search_fallback`

Fallback search with provider fallback order.

**Requirements**

- Exa MCP endpoint is available without additional auth.
- Optional authenticated Pi providers:
  - `google-gemini-cli` (Gemini)
  - `openai-codex` (OpenAI Codex)
- Default fallback order is `gemini` → `openai` → `exa` (unless overridden via `providers`).

**Provider/model mapping**

- `exa` provider: `exa-mcp-web_search_exa`
- `gemini` provider (`google-gemini-cli`): `gemini-2.5-flash`
- `openai` provider (`openai-codex`): `gpt-5.3-codex`

```ts
web_search_fallback({
  query: string,
  providers?: ("gemini" | "openai" | "exa")[],
  live?: boolean,
  debug?: boolean,
})
```

### `web_fetch`

Fetch URL content via regular HTTP.

**Requirements**

- No additional setup.

**Notes**

- Supports single or batch input (`url` or `urls`).
- Truncation is applied per URL (`perUrlMaxChars`).
- On cancellation/abort, the tool exits with abort (no normal content response).

```ts
web_fetch({
  url?: string,
  urls?: string[],               // batch mode (max 10)
  format?: "auto" | "markdown" | "text" | "html",
  timeoutMs?: number,
  perUrlMaxChars?: number,       // truncation per URL (default 3000)
  concurrency?: number,          // batch concurrency (default 3)
})
```

### `web_fetch_rendered`

Fetch URL content via rendered/browser path (Lightpanda).

**Requirements**

- [`lightpanda`](https://github.com/lightpanda-io/browser) installed and available in your `PATH`.

**Notes**

- Supports single or batch input (`url` or `urls`).
- Truncation is applied per URL (`perUrlMaxChars`).
- On cancellation/abort, the tool exits with abort (no normal content response).

```ts
web_fetch_rendered({
  url?: string,
  urls?: string[],               // batch mode (max 10)
  format?: "auto" | "markdown" | "text" | "html",
  timeoutMs?: number,
  perUrlMaxChars?: number,       // truncation per URL (default 3000)
  concurrency?: number,          // batch concurrency (default 3)
})
```

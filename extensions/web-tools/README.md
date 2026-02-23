# web-tools

Unified web extension for search and fetch tooling.

## Tools

### `web_search`

Search the web with provider fallback.

**Requirements**

- At least one authenticated Pi provider configured for this tool:
  - `google-gemini-cli` (Gemini)
  - `openai-codex` (OpenAI Codex)
- If both are configured, fallback order is `gemini` → `openai` (unless overridden via `providers`).

**Provider/model mapping**

- `gemini` provider (`google-gemini-cli`): `gemini-2.5-flash`
- `openai` provider (`openai-codex`): `gpt-5.3-codex`

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

**Requirements**

- No additional setup.

```ts
web_fetch({
  url: string,
  format?: "auto" | "markdown" | "text" | "html",
  timeoutMs?: number,
})
```

### `web_fetch_rendered`

Fetch URL content via rendered/browser path (Lightpanda).

**Requirements**

- [`lightpanda`](https://github.com/lightpanda-io/browser) installed and available in your `PATH`.

```ts
web_fetch_rendered({
  url: string,
  format?: "auto" | "markdown" | "text" | "html",
  timeoutMs?: number,
})
```

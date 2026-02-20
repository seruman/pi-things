# pi-gemini-search

Minimal Pi extension exposing:

- `gemini_web_search(query)`

Both tools use **Gemini subscription auth** via Pi login (`/login gemini`) through the `google-gemini-cli` provider.

## Install (project-local)

Put this repo in your project, then add extension path in `.pi/settings.json`:

```json
{
  "extensions": [
    "/absolute/path/to/pi-gemini-fetch/index.ts"
  ]
}
```

Or run ad-hoc:

```bash
pi -e /absolute/path/to/pi-gemini-fetch/index.ts
```

## Usage

1. In Pi, authenticate once:

```text
/login gemini
```

2. Ask Pi to use the tool:

- `gemini_web_search` for concise answer + sources

## Notes

- Requires valid OAuth credentials for provider `google-gemini-cli`.
- If auth expires, re-run `/login gemini`.
- Tool execution is streaming-first and streaming-only (no automatic fallback to non-streaming requests).
- Tool UI includes inline progress bars, retry indicators, and concise final summaries.
- `gemini_web_search` keeps default answers compact and appends markdown-formatted `## Sources` with links.

## Smoke test

After `/login gemini`, run:

```bash
bun run smoke
```

Optional overrides:

```bash
SMOKE_SEARCH_QUERY="..." \
SMOKE_FETCH_URL_OK="https://example.com" \
SMOKE_FETCH_URL_FAIL="https://does-not-exist.invalid" \
  bun run smoke
```

## Parity + intentional differences

Compared to `pi-web-access` and `gemini-cli`, this extension intentionally stays minimal:

- Keeps only one tool: `gemini_web_search`.
- Uses Pi subscription auth from `google-gemini-cli` credentials (`token`, `projectId`) via model registry.
- Intentionally does **not** read `~/.pi/agent/auth.json`; auth source is model registry only.
- Implements grounding/citations and source formatting, including grounding redirect URL resolution.
- Uses streaming SSE path for tool execution (chosen for better incremental UI in Pi).
- Single-provider by design (`google-gemini-cli` only; no multi-provider orchestration).
- Does not include curator UI, activity panel, or content database/history features.

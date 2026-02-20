# TODO

## Core parity work (Gemini CLI)

- [x] Add **grounding/citations** support for `web_search`; NOTE we should do whatever gemini-cli does, nothing more nothing less. If any of the following are missing from gemini-cli, add note to this TODO to audit vs gemini-cli and decide whether to implement or not. If we miss any of the gemini-cli features, add them here:
  - [x] Parse `groundingMetadata.groundingChunks`
  - [x] Parse `groundingMetadata.groundingSupports`
  - [x] Insert inline citation markers into response text (byte-safe / UTF-8-safe approach)
  - [x] Append deduped `Sources:` list at the end
- [x] Add grounding support to `fetch_content` when available
- [x] Resolve grounding redirect URLs (`vertexaisearch...grounding-api-redirect/...`) to canonical source URLs
  - [x] Try `HEAD` with `redirect: "manual"` and read `Location`
  - [x] Fallback to original URL when resolution fails
- [x] Track and handle `urlContextMetadata` retrieval statuses (success/unsafe/error)

## Compare + close gaps vs `pi-web-access` vs `gemini-cli`

- [x] Audit differences against `/Users/selman/src/github.com/nicobailon/pi-web-access`:
  - [x] Auth handling robustness (JSON apiKey payload + auth fallback behavior) against gemini cli.
  - [x] Grounding source URL cleanup (redirect resolution where needed)
  - [x] Error paths and fallback behavior quality
- [x] Decide explicitly which features we keep intentionally minimal vs adopt from pi-web-access

### Audit notes / decisions (documented baseline)

- Auth:
  - Keep: Pi `modelRegistry.getApiKeyForProvider("google-gemini-cli")` JSON payload (`token`, `projectId`).
  - Do not adopt: `~/.pi/agent/auth.json` fallback probing from `pi-web-access` (intentionally out of scope).
- Request mode:
  - Keep: streaming-only execution path (`:streamGenerateContent?alt=sse`).
  - Do not adopt (for now): stream→non-stream fallback in tool path.
  - Note: official `gemini-cli` web tools generally use non-stream `generateContent`; we intentionally prefer streaming for Pi UX.
- Grounding/sources:
  - Keep: parse grounding chunks/supports, UTF-8-safe citation insertion, deduped `Sources:`.
  - Keep: grounding redirect URL resolution via `HEAD` + `Location` with fallback to original URL.
- Errors:
  - Keep: retry only on retryable status/network failures; no retries on abort/non-retryable failures.
  - Keep: normalized user-facing error summaries + status code where available.
- Scope:
  - Keep minimal: only `gemini_web_search`.
  - Do not adopt (for now): curator/review window, activity widget, content store/browser, video/github extras.
  - Do not adopt: multi-provider orchestration (single-provider `google-gemini-cli` only).

## Reliability

- [x] Add request retry policy for Cloud Code Assist calls:
  - [x] Retry on 429/5xx + transient network errors
  - [x] Exponential backoff with cap
  - [x] Respect abort signal during sleep/retry
  - [x] Better error normalization for user-facing failures
- [x] Add basic timeout configuration per tool

## Streaming

- [x] SSE/streaming path using `:streamGenerateContent?alt=sse`
- [x] Stream partial text via `onUpdate` for long responses
- [x] Streaming-only behavior (no non-streaming fallback in tool execution path)

## UI / user niceties

- [x] Improve progress messages:
  - [x] `Searching…` / `Fetching…` / `Retrying…` with attempt count
  - [x] concise final status summary
- [x] Add cleaner output formatting:
  - [x] compact default answer
  - [x] markdown rendering for citations + sources
  - [x] On errors show error message + relevant details (e.g. status code, error text) with error specific formatting.
- [x] Improve source rendering readability (title + hostname + URL)

## Dev quality

- [ ] Replace `any` types in auth/response parsing with concrete interfaces, use schemas where helpful to both validate/parse and type safety in type system.
- [ ] Add small fixture-based tests for response parsing/citation insertion
- [x] Add smoke test script for both tools (authenticated local run)

# gemini-search

Web search via Gemini subscription auth (from `/login gemini`).

## Tools

### `gemini_web_search`

Search the web. Returns a concise answer with source links.

```
gemini_web_search({
  query: string,          // search query
  debug?: boolean,        // include raw Gemini output for debugging
})
```

- Uses streaming SSE for incremental results
- Resolves grounding/citation redirect URLs
- Appends `## Sources` with markdown links
- Retries on transient failures with progress updates

## Auth

Requires valid OAuth credentials for `google-gemini-cli` provider. Authenticate with `/login gemini` in pi. Re-run if auth expires.

---
name: web-search-guidance
description: Use for precise web searches when the user needs better query construction, domain scoping, file-type filtering, recency filtering, language targeting, or Goggles-based reranking.
---

# Brave Web Search

Use this skill when web results are noisy or when the user wants targeted search behavior.

## How to use this in pi

- Use `web_search` for Brave search.
- Put the search text in `query` or `queries`.
- Use tool params for filtering:
  - `freshness` for time windows
  - `searchLang` for preferred language
  - `country` / `uiLang` for regional behavior
  - `goggles` for custom reranking
  - `extraSnippets` when the first snippet is not enough
- After identifying promising URLs, use `web_fetch` or `web_fetch_rendered` to inspect page content.

## Query syntax

Brave supports standard search operators inside the query string.

| Goal | Syntax | Example |
|---|---|---|
| Restrict to a site/domain | `site:example.com` | `site:github.com/microsoft typescript project references` |
| Match file extension | `ext:pdf` | `postgres indexing ext:pdf` |
| Match file type | `filetype:pdf` | `zig allocator guide filetype:pdf` |
| Require term in title | `intitle:term` | `intitle:changelog bun sqlite` |
| Require term in body | `inbody:term` | `inbody:"breaking change" react router` |
| Require term in page | `inpage:term` | `inpage:benchmark bun sqlite` |
| Restrict by language | `lang:de` | `lang:de bun sqlite tutorial` |
| Restrict by country | `loc:us` | `loc:us privacy law updates` |
| Force include term | `+term` | `jaguar +car` |
| Exclude term | `-term` | `jaguar -car -animal` |
| Exact phrase | `"exact phrase"` | `"agent skills"` |
| Boolean AND | `A AND B` | `bun AND sqlite` |
| Boolean OR | `A OR B` | `bun OR deno benchmark` |
| Boolean NOT | `NOT term` | `python packaging NOT poetry` |

## Freshness values

Use the `freshness` tool parameter, not query text.

| Value | Meaning |
|---|---|
| `pd` | Past day |
| `pw` | Past week |
| `pm` | Past month |
| `py` | Past year |
| `YYYY-MM-DDtoYYYY-MM-DD` | Custom date range |

Examples:
- `freshness: "pw"`
- `freshness: "2026-01-01to2026-03-01"`

## Search recipes

### Official docs
- `site:docs.example.com "feature name"`
- `site:developer.mozilla.org AbortController`

### GitHub code/docs discovery
- `site:github.com/org/repo "symbol name"`
- `site:github.com "release notes" "repo name"`

### PDF/manual search
- `"topic" filetype:pdf`
- `site:example.com filetype:pdf installation guide`

### Recent updates
- Query with `freshness: "pm"` or `"pw"`
- Example: `bun sqlite changelog`

### Reduce spam/noise
- `term -site:pinterest.com -site:quora.com`
- add `site:` when the trusted source is known

### Multilingual search
- set `searchLang`
- optionally add `lang:xx` in the query when exact language filtering matters

## Goggles

Goggles rerank Brave results.

Use Goggles when:
- the user wants trusted-source prioritization
- results are polluted by SEO spam
- you have a known hosted Goggle definition

Pass them via the `goggles` array tool parameter.

## Query construction guidelines

- Keep the `query` focused on the topic, entity, source, and exact terms you want to match.
- Prefer tool parameters over natural-language filter phrases in the query:
  - use `freshness` instead of adding phrases like `past month`, `last week`, or `today`
  - use `searchLang` for language preference
  - use `country` / `uiLang` for regional behavior
  - use `goggles` for reranking
- Avoid expressing the same constraint both in query text and in tool parameters unless you specifically need both.

## Notes

- Prefer a small number of precise operators over long complicated queries.
- Use `site:` early when the source is known.
- Use `extraSnippets: true` when deciding between similar results.
- After search, fetch the top URLs instead of relying only on snippets.

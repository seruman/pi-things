# fetch

Local fetch extension.

Tools:
- `fetch_content` — fetch one or multiple URLs and extract readable content locally (tries Lightpanda first, then HTTP `fetch` with `text/markdown`/`text/plain` preference, then HTML extraction)
- `get_fetch_content` — retrieve stored full content by `responseId` + `url/urlIndex`

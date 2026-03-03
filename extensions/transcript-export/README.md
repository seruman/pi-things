# transcript-export

Exports the active Pi session branch to a single HTML file with a brutalist Tailwind design.

## Command

- `/transcript-html` → writes `./transcript-YYYYMMDD-HHMMSS.html`
- `/transcript-html ./path/to/file.html` → writes to a custom path

## Notes

- Uses Tailwind Play CDN: `https://cdn.tailwindcss.com`
- Includes user, assistant, tool, and session event entries from the active branch
- Output is a standalone HTML document

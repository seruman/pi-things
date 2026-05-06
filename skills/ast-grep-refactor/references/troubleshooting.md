# Troubleshooting

## No matches

- Confirm `language` is correct.
- Inspect AST with `--debug-query=ast`.
- Simplify the rule and add constraints back one at a time.
- Add `stopBy: end` on relational rules when needed.

## Too many matches

- Add `inside` or `has` to narrow context.
- Restrict with `field` or `nthChild`.
- Add `not` to exclude known false positives.

## Broken output

- Use `FixConfig` to expand to commas or separators.
- Match statement nodes (not just expressions) to avoid empty statements.
- For list edits, match the list item node and adjust `expandStart`/`expandEnd` to avoid extra commas.
- Ensure multi-line `fix` indentation is correct.
- Run the formatter for the target language.

## Slow scans

- Limit paths and file globs.
- Use `kind` to reduce search space.

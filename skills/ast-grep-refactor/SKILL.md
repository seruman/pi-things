---
name: ast-grep-refactor
description: Structural refactoring and safe code rewrites with ast-grep across supported languages. Use for codemods, removing or replacing AST nodes (imports, docstrings, arguments), pattern-based migrations, and multi-file transformations where text-based replace is risky.
---

# ast-grep Refactor

Use ast-grep to refactor by AST, not by text. Keep rules small, test on samples, then scale to the codebase.

## Quick workflow

1. Inspect AST for the target pattern.
2. Write a rule that matches only what you intend.
3. Dry-run on small files and review diffs.
4. Apply at scale only after review or tests.
5. Format and run checks.

```bash
ast-grep run --pattern '...' --lang <language> --debug-query=ast path/to/file
ast-grep scan -r rule.yml path/to/file
ast-grep scan -r rule.yml --update-all path/glob/**
```

Review matches via `ast-grep scan` output, `--interactive`, or `git diff` before `--update-all`.

## Decide the rule shape

- Use `pattern` for simple rewrites with metavariables.
- Use `kind` plus relational rules (`inside`, `has`, `nthChild`) for structural or positional changes.
- Use `fix` string for direct replacement; use `FixConfig` when you must remove punctuation or neighbors.
- Use `transform` to change captured strings; use `rewriters` to rewrite different subnodes differently.

## Rule files

- Separate multiple rules with `---`.
- Keep rules focused and composable.
- For repeatable or risky changes, add rule tests and run `ast-grep test`.

## References

- Rule basics and selection: `ast-grep-refactor/references/rule-basics.md`
- Rewrite and `fix`: `ast-grep-refactor/references/rewrite.md`
- FixConfig expansion: `ast-grep-refactor/references/fix-expand.md`
- Transformations: `ast-grep-refactor/references/transform.md`
- Rewriters: `ast-grep-refactor/references/rewriter.md`
- Troubleshooting: `ast-grep-refactor/references/troubleshooting.md`
- Examples: `ast-grep-refactor/references/examples.md`

## When to skip ast-grep

- Very small, one-off edits where manual editing is faster.
- Pure text replacement where AST structure does not matter.
- Changes requiring type-aware or semantic analysis.

## Links

- [ast-grep](https://github.com/ast-grep/ast-grep)

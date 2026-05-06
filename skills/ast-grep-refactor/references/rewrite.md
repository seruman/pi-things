# Rewrite and fix

Pick the simplest rewrite that works.

## Fast rewrite

Use `--rewrite` for one-off replacements.

```bash
ast-grep run --pattern 'oldCall($$$ARGS)' --rewrite 'newCall($$$ARGS)' --lang <language>
```

## Rule-based rewrite

Use `fix` in YAML for codemods and multi-rule files.

```yaml
id: rename-call
language: <Language>
rule:
  pattern: oldCall($$$ARGS)
fix: newCall($$$ARGS)
```

## Metavariables

- `$X` matches a single node.
- `$$$X` matches a list of nodes.
- Unmatched metavariables become empty strings in `fix`.

## Indentation

Multi-line `fix` blocks preserve indentation relative to the match location. Keep the indentation in the YAML `fix` body intentional.

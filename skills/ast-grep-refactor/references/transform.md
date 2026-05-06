# Transform

Use `transform` to derive new strings from matched metavariables.

Supported operations include `replace`, `substring`, `convert`, and `rewrite`.

```yaml
rule:
  pattern: $OLD_FN($$$ARGS)
transform:
  NEW_FN: replace($OLD_FN, replace="^old", by="new")
fix: $NEW_FN($$$ARGS)
```

## Notes

- String-style syntax (`replace(...)`) requires ast-grep 0.38.3+.
- Use `replace` to apply regex-based changes.
- Use `convert` for case changes (camelCase, snake_case, etc.).
- Use `rewrite` to apply rewriter rules to a subtree.

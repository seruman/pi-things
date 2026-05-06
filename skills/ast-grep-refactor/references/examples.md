# Examples

Use these as templates. Replace placeholders after inspecting the AST.

## Replace a call

```yaml
id: replace-call
language: <Language>
rule:
  pattern: oldCall($$$ARGS)
fix: newCall($$$ARGS)
```

## Remove a structural node by context

```yaml
id: remove-node
language: <Language>
rule:
  kind: <statement_kind>
  inside:
    kind: <parent_kind>
    stopBy: end
fix: ""
```

Prefer matching statement nodes to avoid leaving empty statements or stray separators.

## Remove a list item and its separator

```yaml
id: remove-item
language: <Language>
rule:
  kind: <list_item_kind>
  has:
    regex: <match_text>
fix:
  template: ""
  expandEnd: { regex: "," }
```

If the result leaves an extra separator, match the list item node (not the literal) and adjust `expandStart` or use separate rules for last vs middle items.

## Transform a captured name

```yaml
id: rename-with-transform
language: <Language>
rule:
  pattern: $OLD_NAME($$$ARGS)
transform:
  NEW_NAME: replace($OLD_NAME, replace="^old", by="new")
fix: $NEW_NAME($$$ARGS)
```

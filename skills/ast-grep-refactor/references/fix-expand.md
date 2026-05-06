# FixConfig expansion

Use `FixConfig` when removing or replacing a node requires deleting adjacent punctuation or separators.

```yaml
rule:
  kind: <list_item_kind>
  has:
    regex: <match_text>
fix:
  template: ""
  expandEnd: { regex: "," }
```

## Notes

- `template` is the replacement string (empty string deletes).
- `expandStart` and `expandEnd` accept rule objects and expand the replacement range until the rule fails.
- Use expansion to capture commas, extra whitespace, or delimiters.
- If you see doubled separators, match the list item node and adjust `expandStart` vs `expandEnd`, or split into separate rules for last vs middle items.

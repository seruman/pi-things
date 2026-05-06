# Rewriters

Use `rewriters` when different subnodes need different fixes.

## Skeleton

```yaml
rewriters:
- id: sub-rule
  rule: { kind: <subnode_kind> }
  fix: <replacement>

rule:
  pattern: target($$$ARGS)

transform:
  NEW_ARGS:
    rewrite:
      rewriters: [sub-rule]
      source: $$$ARGS

fix: target($NEW_ARGS)
```

## Notes

- Order of `rewriters` matters if multiple match the same node.
- Use `joinBy` to control how rewritten items are joined.

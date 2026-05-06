# Rule Basics

Build a rule from these parts:

- Atomic: `pattern`, `kind`, `regex`, `nthChild`, `range`
- Relational: `inside`, `has`, `precedes`, `follows`
- Composite: `all`, `any`, `not`, `matches`

Use at least one positive matcher (`pattern`, `kind`, or a `matches` utility). A `regex`-only rule is not positive.

## Choose the key

- Use `pattern` for recognizable code shapes with metavariables.
- Use `kind` for structure-first matching or when text is unreliable.
- Use `inside`/`has` to restrict to context or require descendants.
- Use `nthChild` for positional matches among siblings (1-based).
- Use `all`/`any`/`not` to combine or exclude matches.

## Skeleton

```yaml
id: rule-id
language: <Language>
rule:
  pattern: target($$$ARGS)
fix: replacement($$$ARGS)
```

## Relational controls

- `stopBy: neighbor` stops at immediate surroundings.
- `stopBy: end` searches to the boundary of the relation.
- `field` is only valid on `inside` and `has` to select a sub-node.

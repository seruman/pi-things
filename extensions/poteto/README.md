# Poteto

An opt-in pstack skill pack, vendored under [`vendor/pstack/`](./vendor/pstack/UPSTREAM.md) with a [pi adapter](./vendor/pstack/ADAPTER.md).

## Commands

- `/poteto` toggles the whole pack for this session. It is off by default.
- `/poteto on` and `/poteto off` set it explicitly.
- `/poteto repo` flips the default for the current folder and its descendants, and applies it to this session. A nested folder can override its parent without changing siblings.

Toggling reloads pi's resources. When off, none of this pack's skills are registered: no slash commands or automatic model selection. When on, `poteto:on` appears in the status line, the skills become available, and the full vendored `poteto-mode` instructions plus `ADAPTER.md` are injected before each task. Five skills are auto-invocable (`how`, `blast-radius`, `unslop`, `typescript-best-practices`, and the bundled `deslop`); the rest are manual commands or read by another skill.

The toggle is session-wide, including across tree navigation, and survives reload/resume. Explicit session choices take precedence over folder defaults, stored under the pi agent directory in `poteto/defaults/`. Changes apply to future tasks; switching off does not erase earlier conversation context.

Managed subagents do not register the pack or inherit automatic mode injection. Their parent's brief can still point them at the vendored skill files, as the adapter specifies.

Nothing is fetched or updated by toggling. Update the vendored copy with `bun run sync:pstack` and review the diff. Relative links within the pack stay unchanged.

## Files

- `index.ts`: commands, persisted state, conditional skill discovery, prompt injection.
- `vendor/pstack/`: upstream skills, agents, guide, licenses, provenance, and the local adapter.
- `../../tools/sync-pstack.ts`: repeatable vendoring script; preserves `ADAPTER.md`.

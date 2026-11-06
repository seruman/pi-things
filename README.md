# pi-things

Me just prompting the shit out of LLMs to create things I want in pi.

## Things

- [web-search / web-fetch](./extensions/web-tools/README.md)
- [model-router](./extensions/model-router/README.md)
- [subagents](./extensions/subagents/README.md)
- `/split-fork` — clone the current active branch into a new terminal split
- `/split-handoff <goal>` — open a focused handoff as an editable draft in a fresh, parent-linked split; its first turn performs read-only orientation and waits for approval
- `/goal`
- `/comment`
- [pi-safety](./extensions/pi-safety/README.md)
- [shell-leash](./extensions/shell-leash/README.md)
- skills:
  - [git-hunks](./skills/git-hunks/SKILL.md)
  - [git-wt](./skills/git-wt/SKILL.md)
  - [rex](./skills/rex/SKILL.md)
  - [sumocli](./skills/sumocli/SKILL.md)
  - [Matt Pocock skills](./skills/matt-pocock/README.md)
  - [pstack](./skills/pstack/UPSTREAM.md) — vendored from cursor/plugins with a [pi adapter](./skills/pstack/ADAPTER.md); update with `bun run sync:pstack`

## Install

```bash
pi install git:github.com/seruman/pi-things

# or

pi install -l git:github.com/seruman/pi-things

# or

pi install /path/to/local/clone

# IDK just see https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md
```

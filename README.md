# pi-things

Me just prompting the shit out of LLMs to create things I want in pi.

## Things

- [web-search / web-fetch](./extensions/web-tools/README.md)
- `/split-fork` — clone the current active branch into a new terminal split
- `/split-handoff <goal>` — open a focused handoff as an editable draft in a fresh, parent-linked split; its first turn performs read-only orientation and waits for approval
- `/goal`
- `/comment`
- [pi-safety](./extensions/pi-safety/README.md)
- [shell-leash](./extensions/shell-leash/README.md)
- skills:
  - [ast-grep-refactor](./skills/ast-grep-refactor/SKILL.md)
  - [git-hunks](./skills/git-hunks/SKILL.md)
  - [sumocli](./skills/sumocli/SKILL.md)
  - [teteyectl](./skills/teteyectl/SKILL.md)
  - [terminal-browser](./skills/terminal-browser/SKILL.md)
  - [Matt Pocock skills](./skills/matt-pocock/README.md)

## Install

```bash
pi install git:github.com/seruman/pi-things

# or

pi install -l git:github.com/seruman/pi-things

# or 

pi install /path/to/local/clone

# IDK just see https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md
```

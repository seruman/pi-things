# shell-leash

Best-effort guardrail for shell commands in pi sessions. Intercepts the built-in `bash` tool, tries to analyse calls for known destructive shit I can not seem to prevent using AGENTS.md.

Not a sandbox, not a security boundary, just enough to stop me swearing to the slop machine.

## What it guards

| Capability | What it catches |
|---|---|
| `fs.rm` | `rm` |
| `git.commit.amend` | `git commit --amend` |
| `git.checkout` | `git checkout` (branch, path, ours/theirs) |
| `git.switch` | `git switch` |
| `git.restore` | `git restore` (staged, source, path) |
| `git.reset` | `git reset` (soft, mixed) |
| `git.reset.hard` | `git reset --hard` |
| `git.clean` | `git clean` |
| `git.push` | `git push` (regular) |
| `git.push.force` | `git push --force`, `git push --force-with-lease` |
| `gh.pr.create` | `gh pr create` |
| `gh.pr.comment` | `gh pr comment` |
| `gh.pr.merge` | `gh pr merge` |
| `gh.issue.create` | `gh issue create` |
| `gh.issue.comment` | `gh issue comment` |

Tries to detect common shell wrappers; pipelines, command substitutions, `bash -c`, `sh -c`, `env ... bash -c`, `command bash -c`.

## What it does not guard

- Arbitrary CLI tools; `docker rm`, `kubectl delete`, `curl -X DELETE`.
- Indirect execution; `eval`, variable expansion, aliases.
- Non-bash interpreters; `python -c`, `node -e`.
- Unparsable shell syntax; surfaced as a warning, not blocked.

## Approval model

When a guarded command is detected, the extension prompts with:

- **Allow once** -- run this command, prompt again next time
- **Allow `<capability>` for session** -- stop prompting for this specific capability until session ends
- **Deny** -- block execution

Approvals are in-memory only. They reset on `/reload`, `/new`, `/resume`, and pi restart.

## `/shell-leash`

Opens a settings UI to view and toggle session approvals for all capabilities.

## Non-interactive sessions

The extension does nothing outside interactive sessions. No blocking, no warnings, yolo. Sub-sessions -see `subagent-tool`- are in YOLO mode.

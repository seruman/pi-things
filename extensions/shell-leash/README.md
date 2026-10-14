# shell-leash

Best-effort guardrail for shell commands in pi sessions. Intercepts the built-in `bash` tool, tries to analyse calls for known destructive shit I can not seem to prevent using AGENTS.md.

Not a sandbox, not a security boundary, just enough to stop me swearing to the slop machine.

## What it guards

| Capability          | What it catches                                                      |
| ------------------- | -------------------------------------------------------------------- |
| `fs.rm`             | Recursive or forced `rm` (`-r`, `-R`, `-f`, and combined/long forms) |
| `git.commit.amend`  | `git commit --amend`                                                 |
| `git.checkout`      | `git checkout` (branch, path, ours/theirs)                           |
| `git.switch`        | `git switch`                                                         |
| `git.restore`       | `git restore` (staged, source, path)                                 |
| `git.reset`         | `git reset` (soft, mixed)                                            |
| `git.reset.hard`    | `git reset --hard`                                                   |
| `git.clean`         | `git clean`                                                          |
| `git.config.global` | `git config --global ...`                                            |
| `git.push`          | `git push` (regular)                                                 |
| `git.push.force`    | `git push --force`, `git push --force-with-lease`                    |
| `gh.pr.create`      | `gh pr create`                                                       |
| `gh.pr.comment`     | `gh pr comment`                                                      |
| `gh.pr.merge`       | `gh pr merge`                                                        |
| `gh.issue.create`   | `gh issue create`                                                    |
| `gh.issue.comment`  | `gh issue comment`                                                   |

Tries to detect common shell wrappers; pipelines, command substitutions, `bash -c`, `sh -c`, `env ... bash -c`, `command bash -c`.

## What it does not guard

- Arbitrary CLI tools; `docker rm`, `kubectl delete`, `curl -X DELETE`.
- Indirect execution; `eval`, variable expansion, aliases.
- Non-bash interpreters; `python -c`, `node -e`.
- Unparsable shell syntax; surfaced as a warning, not blocked.

## Approval model

Guarded commands prompt for **Allow once**, **Allow `<capability>` for session**, or **Deny**.

Every denial stops the current run, including dismissed prompts and missing approval UI. Pi stays open. Already-running tools cannot be undone.

Session approvals reset on `/reload`, `/new`, `/resume`, and restart. `/shell-leash` toggles them; CLI rules stay fixed.

## Policy

- `--shell-leash-allow git.checkout,git.switch` allows listed capabilities.
- `--shell-leash-deny fs.rm` denies listed capabilities; deny wins over allow.
- `--shell-leash-default ask|deny` controls other guarded capabilities; defaults to `ask`.

Subagents inherit allows and denies, turn asks into denies, and do not inherit “Allow once”. A denied child stops and reports the reason to its parent.

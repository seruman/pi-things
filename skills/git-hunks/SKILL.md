---
name: git-hunks
description: Selective hunk-level staging and commits with git-hunks. Use when the user asks to split changes into multiple logical commits, stage individual hunks instead of whole files, make surgical commits from a dirty worktree, or review changes at hunk granularity before committing. Also use when the user asks to "commit in hunks," "commit by hunk," or requests fine-grained staging.
---

# git-hunks

Use git-hunks to stage individual hunks instead of whole files. Review at hunk granularity, group related changes, and make focused commits.

## Quick workflow

1. List all unstaged hunks and review their diffs.
2. Group hunks that belong to the same logical change.
3. Stage one group, commit, repeat for remaining groups.

```bash
git hunks list
git hunks add '<hunk-id>' '<hunk-id>'
git commit -m "description of this logical change"
```

Always quote hunk IDs — they contain special characters (e.g., `src/main.c:@-10,6+10,7`).

## Commands

- `git hunks list` — show all unstaged hunks with stable IDs and inline diffs
- `git hunks list --staged` — show staged hunks (use to verify before committing)
- `git hunks add <id> ...` — stage one or more hunks by ID

Hunk IDs are stable: staging one hunk does not change the IDs of other hunks.

## Grouping hunks into commits

Read every hunk diff from `git hunks list` before deciding groups. Group by logical change:

- A new feature: the implementation hunk + its import hunk + its test hunk
- A bug fix: the fix hunk + the regression test hunk
- A refactor: all related rename/move hunks together

Stage and commit one group at a time. Do not mix unrelated changes.

## Verification loop

After staging, always verify before committing:

```bash
git hunks list --staged   # confirm exactly the right hunks are staged
git hunks list            # confirm remaining hunks are still pending
git diff --staged         # review the full staged diff
git commit -m "focused commit message"
```

## When to skip git-hunks

- All changes in a file belong to the same logical commit — use `git add <file>`.
- Changes need manual editing before staging — use `git add -p` interactively.

## Links

- [git-hunks](https://github.com/rockorager/git-hunks)

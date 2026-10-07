---
name: git-wt
description: Use for requests to create, locate, list, or remove Git worktrees, including immediately after cloning a repository, or to carry uncommitted work into a separate worktree. Use git-wt rather than native git worktree commands for these operations, even when no local files need copying. Also use when the user mentions git wt or git-wt. Not for ordinary branch switching or clone-only requests.
---

# git-wt

Use `git wt` for the requested worktree operation. Creation, removal, commits, merges, pushes, and branch deletion are separate actions; do only those authorized by the request.

Run `git wt` directly without environment preflight checks. Consult `git wt -h` or a subcommand's `-h` when syntax is unclear; troubleshoot environment issues only if the command reports an error.

## Choose the source and operation

Run these examples from the source checkout. Ignored files and `--dirty` changes come from this checkout.

```bash
git status --short
git wt list --json
```

If the target branch is already checked out, show its worktree path and ask whether to reuse that worktree or create a different branch in a new worktree. Wait for the decision before proceeding; another task or agent may be using it.

Use Git's `-C` before `wt` only when operating from another directory. Keep subsequent shell commands, edits, and delegated work in the chosen worktree; a `cd` in one tool call may not persist into another.

## Create

```bash
git wt new fix-auth --json
```

A new branch starts at the source HEAD by default. An existing branch keeps its current tip. Omit the branch name to let git-wt choose an unused name such as `main-1`. Creation requires a committed source HEAD.

To create a new branch and worktree from an existing branch:

```bash
git wt new auth-tests --base feature/auth --json
```

This creates `auth-tests` at the tip of `feature/auth` without changing `feature/auth`, even if the base branch is checked out elsewhere. `--base` also accepts remote-tracking refs such as `origin/main`; it does not fetch them. If the target branch already exists, it must be at the same commit as the base.

Choose additional options according to what the user wants:

| Intent | Option | Behavior |
| --- | --- | --- |
| Carry uncommitted work | `--dirty` | Carries tracked changes and untracked files as well as ignored files, without preserving staging. Requires the source HEAD as the starting commit. |
| Omit ignored local files | `--exclude node_modules` | Skips that root-relative ignored path. Repeat the option for additional paths. |
| Create an ordinary checkout | `--no-clone` | Carries no local files. Cannot be combined with `--dirty`. |
| Use a specific destination | `--path /absolute/destination` | Overrides configured placement; the destination must not already exist. |

Without `--dirty`, uncommitted tracked changes and nonignored untracked files are not carried. Ignored environment files such as `.env`, dependencies, and caches are cloned by default. Files that disappear during ignored-file copying may be skipped, so check any environment file actually needed by the task rather than assuming it arrived.

Exclusions from `gwt.exclude` and `--exclude` combine and affect ignored files only. They are literal root-relative path prefixes, not globs or recursive basename matches: `cache` excludes `cache/` but not `packages/cache/`. Absolute paths and parent traversal are rejected.

Nested repositories are not copied as local environment files. If dirty creation refuses a populated nested repository, report that boundary rather than copying its Git metadata or initializing submodules as a workaround.

## Use returned paths

`new --json` returns an object containing `path`, `branch`, and `head`, along with source and cloning details. Capture the command's exit status and stdout separately from stderr; parse JSON only after success. Shell tools may return combined stdout and stderr: do not JSON-parse that combined text. Use separate subprocess capture or redirect stdout to a unique temporary file created with `mktemp`. Do not pipe creation directly into a directory change or hide its failure behind a parser's exit status.

```bash
git wt path fix-auth --json
```

`path --json` returns `{"path":"/absolute/path"}`. `list --json` returns an array of worktree records; use its paths and flags rather than parsing aligned human output. When a selector is ambiguous, resolve the intended absolute path from the inventory.

Use the returned absolute path as the working directory for the task. Report the path and branch; continue any requested coding work there.

## Remove

Set `target` to the absolute path returned by `wt path` or selected from the inventory, then inspect its local files:

```bash
git -C "$target" status --short --untracked-files=normal --ignored=matching
```

A worktree may contain valuable ignored files even when ordinary status looks clean. Run removal from another worktree in the same repository:

```bash
git wt remove "$target"
```

Removal retains the branch. The main and current worktrees cannot be removed. Use `--force` only when discarding the target's local files and changes is authorized; a refusal alone is not permission to force removal. Report the removed path and retained branch.

## Failed or interrupted creation

Git or copy errors trigger best-effort cleanup; new branches are kept. Interruptions and crashes may leave incomplete worktrees. Git runs hooks normally; git-wt does not supervise their background jobs or guarantee bounded completion.

After a failed or interrupted command, inspect the worktree inventory, destination, and branch before retrying. A directory or registration alone does not prove creation completed, and a final output error can leave a completed worktree. Report what remains and any uncertainty. Do not automatically delete destinations, prune registrations, reset branches, or switch to `--no-clone` to make a retry succeed.

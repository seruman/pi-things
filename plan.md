# Pi extensions simplification plan

## Principles

- Optimise for personal use, not public extensibility.
- Keep features that are used daily, even if they are a bit bespoke.
- Prefer one obvious path over provider/mode matrices.
- Prefer single-file extensions unless a split removes real complexity.
- Keep UI/progress where it improves day-to-day use.
- Do not turn guardrails into sandboxes. `shell-leash` and `secret-guard` stay intentionally narrow.

## Immediate bug fixes

### 1. Fix `subagent-tools` `submit_result` capture

Current issue: `extensions/subagent-tools/index.ts` treats `submit_result` as successful when it sees `tool_call_start` or `tool_execution_start`. That is too early. A tool call can be malformed, blocked, or fail, but the parent may already accept it as the subagent result.

Plan:

- Stop calling `captureSubmitResult()` from `tool_call_start` and `tool_execution_start`.
- Capture only from the completed tool result event emitted by Pi JSON mode.
- Parse the actual `submit_result` tool result details or output, not just proposed arguments.
- Preserve progress events for `tool_call_start` / `tool_execution_start`, but treat them as display-only.
Acceptance:

- A child that attempts invalid `submit_result` is marked failed.
- A child that calls `submit_result({ status: "aborted" })` without an error is marked failed.
- A valid `submit_result` still becomes the final subagent output.

No dedicated tests needed for this personal extension. Validate manually with a real delegated task.

### 2. Add subagent typecheck coverage

Plan:

- Add `extensions/subagent-tools/tsconfig.json` consistent with the other extensions.
- Add a root script, for example `typecheck:subagent-tools`.
- Consider one root `typecheck` script for all extensions.

## `subagent-tools` simplification pass

Keep:

- `agent/<name>.md` style project-local agents.
- User agents.
- Project agents.
- Trust prompt for project agents in UI sessions.
- Single and parallel delegation.
- Live progress UI.
- `/subagents-running` live/recent history, because it is useful.
- Internal `submit_result` contract after fixing the bug.

Drop:

- Chain mode.
- Bundled prompt templates that exist only to drive chain mode:
  - `extensions/subagent-tools/prompts/sub:implement.md`
  - `extensions/subagent-tools/prompts/sub:implement-and-review.md`
  - `extensions/subagent-tools/prompts/sub:scout-and-plan.md`
- Chain-specific code paths and `{previous}` substitution.

Simplify:

- Keep `single` and `tasks[]` as the only modes.
- Reduce mode validation to: exactly one of `task` or `tasks`.
- Remove `ChainItem`, `chain` schema, and chain render labels.
- Keep the live run map, but isolate it from execution logic.
- Consider splitting `index.ts` into:
  - `index.ts` for Pi registration
  - `runner.ts` for spawning/parsing child Pi
  - `agents.ts` remains as-is
  - optional `ui.ts` only if render code stays large

Potential later simplification:

- Drop auth-failure retry if it no longer happens in practice.
- Drop `PI_SUBAGENT_BIN` legacy support.
- Keep `PI_SUBAGENT_COMMAND` only if you use it.

## `task-tools` simplification pass

Context:

Armin's `todos.ts` is also big and has file-backed storage, locking, ownership/assignment, and a TUI. So the existence of a rich todo/task extension is not the problem. The overengineering is mainly the dependency graph and duplicated metadata/body fields.

Keep:

- YAML + markdown storage. It is human-readable and useful.
- One file per task/todo.
- `/tasks` TUI.
- The compact widget.
- Session ownership if you use multiple Pi sessions.
- File locking, but keep it simple.

Drop or reduce:

- Dependency graph copied from Claude Code:
  - `blocks`
  - `blockedBy`
  - cycle detection
  - `includeCompletedBlockers`
  - dependency filtering
- `activeForm` if it is not used in prompts/UI.
- `metadata` if it is not used by real workflows.
- `purge all` if it feels dangerous or unused.

Fix description storage:

- Make the markdown body the single source of truth for `description`.
- Remove `description` from YAML frontmatter, or keep it only as a backwards-compatible read fallback.
- When serialising, write description only in the body.
- When reading old files with YAML `description`, prefer body if non-empty, otherwise fallback to YAML.

Simpler task shape:

```yaml
---
id: "1"
subject: "Do the thing"
status: pending
owner: null
created_at: "..."
updated_at: "..."
---

Human-readable description here.
```

Tool API after simplification:

- `list`
- `get`
- `create`
- `update`
- `claim`
- `release`
- `purge completed`

Potentially remove:

- `addBlocks`
- `addBlockedBy`
- `includeCompletedBlockers`
- `metadata`
- `activeForm`

Validation:

- Use TypeBox for the Pi tool schema.
- Use small runtime validation for parsed markdown/YAML from disk.
- Avoid validating the same tool input through TypeBox and zod unless it catches a real class of bugs.

## `web-tools` simplification pass

Goal:

Keep the useful UI/progress, but remove fallback search complexity and batch modes.

Split into two extensions:

1. `web-search`
   - Brave only.
   - Single query only.
   - Keep progress UI and result renderer.
   - Keep useful Brave options only.

2. `web-fetch`
   - HTTP fetch.
   - Rendered fetch.
   - Single URL only.
   - Keep progress UI.

Drop:

- `web_search_fallback` tool.
- OpenAI provider.
- Exa provider.
- provider fallback plumbing.
- batch search via `queries`.
- batch fetch via `urls`.
- batch concurrency helpers.
- fallback search README sections.

Likely deletions:

- `extensions/web-tools/search/search.tool.ts`
- `extensions/web-tools/search/providers/openai.ts`
- `extensions/web-tools/search/providers/exa.ts`
- `extensions/web-tools/search/providers/auth.ts`
- much of `extensions/web-tools/search/providers/shared.ts`, unless Brave retries still use it
- `queries` support in `brave-search.tool.ts`
- `urls` support in fetch files

Keep or adapt:

- Brave result formatting.
- Search progress renderer.
- Fetch progress renderer.
- `defuddle` extraction.
- Lightpanda rendered fetch.

New structure option:

```text
extensions/web-search.ts
extensions/web-fetch.ts
```

Or, if keeping folders:

```text
extensions/web-search/index.ts
extensions/web-fetch/index.ts
```

For personal use, single-file extensions are preferred if the files remain readable.

## `secret-guard` fix and clarification

### Symlink / `realpath` fix

Current behaviour:

- `matchProtectedRead()` uses `path.resolve(config.root, requestedPath)`.
- This normalises `..` and relative paths, but it does not resolve symlinks.

Why that matters:

- Suppose `safe-link` is a symlink to `.env`.
- The requested path is `safe-link`.
- `path.resolve()` sees something harmless like `/repo/safe-link`.
- Pattern matching does not see `.env`.
- The read can bypass the guard.

`realpath` means asking the filesystem for the actual target path after following symlinks. For example:

```ts
fs.realpathSync("/repo/safe-link") // -> "/repo/.env"
```

Plan:

- In `matchProtectedRead()`, compute both:
  - lexical path via `path.resolve()`
  - real path via `fs.realpathSync.native()` when the path exists
- Run protection matching against both.
- If either path matches, block.
- If `realpath` fails because the file does not exist, fall back to lexical matching.
- Keep this simple and validate manually. No new test suite needed.

### Default patterns rooted at filesystem root

What I meant:

- Built-in default rules are created with root `/` via `path.parse(root).root`.
- That means defaults match protected names anywhere on disk, not just inside the project.
- Example: reading `/tmp/foo/.env` can be blocked because relative-to-`/` still contains `.env`.

That is probably fine for your intent: protect obvious secret filenames globally. It just means defaults are broader than project rules.

Keep:

- Only protecting the `read` tool.
- No overlap with `shell-leash` beyond obvious documentation.

## `shell-leash`

Keep as-is conceptually.

Rationale:

- It is intentionally not a sandbox.
- It is intentionally narrow.
- It is intentionally disabled in non-interactive/subagent flows to avoid constant prompts.

Possible tiny cleanup only:

- Keep tests here because shell parsing has real edge cases.
- Avoid expanding capability scope unless a command annoys you in real use.
- No need to make it cover `secret-guard` concerns.

## `split-fork`

Keep direction flags.

Rationale:

- You use them.
- The file is still small enough.
- This is acceptable personal-use complexity.

No simplification needed beyond normal maintenance.

## Repo cleanup

### Typecheck/scripts

Add root scripts for all extensions:

```json
{
  "typecheck:web-tools": "tsc -p extensions/web-tools/tsconfig.json",
  "typecheck:task-tools": "tsc -p extensions/task-tools/tsconfig.json",
  "typecheck:subagent-tools": "tsc -p extensions/subagent-tools/tsconfig.json",
  "typecheck:shell-leash": "tsc -p extensions/shell-leash/tsconfig.json",
  "typecheck:secret-guard": "tsc -p extensions/secret-guard/tsconfig.json",
  "typecheck": "bun run typecheck:web-tools && bun run typecheck:task-tools && bun run typecheck:subagent-tools && bun run typecheck:shell-leash && bun run typecheck:secret-guard"
}
```

If `split-fork.ts` stays at top level, either include it in a root `tsconfig.json` or create a tiny extension-level typecheck path for it.

### Package shape

Current per-extension `package.json` files are inconsistent.

Options:

1. Personal repo style:
   - one root `package.json`
   - no per-extension packages unless installing an extension standalone

2. Standalone package style:
   - every extension gets package metadata and tsconfig

Recommendation: personal repo style. Remove per-extension package files that are not actively used for standalone installs.

## Suggested execution order

1. Fix `submit_result` capture.
2. Add subagent typecheck.
3. Remove subagent chain mode.
4. Fix `secret-guard` symlink handling.
5. Simplify `web-tools`:
   - remove fallback providers
   - remove batch mode
   - split search/fetch if still desired after deletion
6. Simplify `task-tools`:
   - make markdown body the description source
   - remove dependency graph
   - then reassess whether ownership/metadata/activeForm should stay
7. Clean root scripts/package shape.

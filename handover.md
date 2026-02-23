# Handover — subagent-tools + task-tools

## Current Status

We implemented major subagent/task orchestration improvements, but a few critical items remain.

### Completed

- Switched task lifecycle handling to orchestrator-side for subagent runs:
  - On `subagent spawn` with `taskId`: orchestrator claims + sets `in_progress`.
  - On completion/stop paths currently wired in tool flow: orchestrator sets final status and clears owner.
- Subagent output is file-backed:
  - `/tmp/pi-subagents/<sessionId>/<agentId>.output`
  - stderr sibling file also written.
- Subagent registry eviction behavior improved:
  - no early silent disappearance after notification injection.
- Subagent widget layout fixed (removed fragile box frame causing overflow/kayma).
- Task rendering changed to Claude-like style:
  - summary line + `✔ / ◼ / ◻`
  - blockers display
  - activeForm shown as indented progress line
- Task display ordering improved:
  - `in_progress -> pending/open -> completed`
- Compact widget now focuses on active (non-completed) tasks.

## Critical Outstanding Items

### 1) Hard-enforce worker/task separation (NOT fully done)

**Problem:** Subagents still receive `task-tools` extension and can mutate task graph directly.

**Why it matters:** Claude-style semantics require workers not to manage task graph.

**Needed:**
- In extension forwarding (`extensions/subagent-tools/spawn.ts`), exclude `task-tools` from forwarded extensions for subagents.
- Keep orchestrator as sole task manager.
- Re-test spawn flows with `taskId` to ensure no worker-side task tool usage is needed.

### 2) Background completion finalization gap

**Problem:** For background agents, task finalization is currently guaranteed when orchestrator calls `output`/`stop`; if not polled, task may stay `in_progress`.

**Needed:**
- Finalize task on process close event (registry lifecycle hook), not only when `output` is consumed.
- Ensure idempotency (avoid double-finalize when `output` is called later).

## Important Follow-ups

### 3) `/agents` interactive command

Planned in spec, not implemented yet.

### 4) Notification mechanism constraints

Pi extension tool contexts expose `ReadonlySessionManager`; cannot call `appendCustomMessageEntry` directly there.
Current notification injection is via `before_agent_start` custom message batching.

### 5) Open questions from spec

- stdout streaming to UI in realtime
- output truncation/summarization strategy
- resumable subagents (`--continue`)

## Files Touched Recently

- `extensions/subagent-tools/index.ts`
- `extensions/subagent-tools/subagent.tool.ts`
- `extensions/subagent-tools/spawn.ts`
- `extensions/subagent-tools/registry.ts`
- `extensions/subagent-tools/types.ts`
- `extensions/subagent-tools/SPEC.md`
- `extensions/task-tools/index.ts`
- `extensions/task-tools/task-ui.ts`

## Suggested Next Implementation Order

1. Enforce no task-tools forwarding to subagents (`spawn.ts`).
2. Move background task finalization to process-close lifecycle (single source of truth).
3. Add idempotent finalize guard (e.g., per-agent finalized flag in registry).
4. Implement `/agents` command.
5. Re-run end-to-end dependency-wave test and orphan-process checks.

## Validation Checklist

- `npx tsc --noEmit` in:
  - `extensions/subagent-tools`
  - `extensions/task-tools`
- Root: `npm run check:write`
- Manual smoke tests:
  - blocking spawn + task finalization
  - background spawn without `output` poll still finalizes task
  - stop path resets task properly
  - no orphan child processes
  - widget does not overflow

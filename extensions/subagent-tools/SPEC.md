# subagent-tools

Parallel subagent orchestration for pi via non-interactive `pi -p` child processes.

## Motivation

Pi does not have built-in subagent/parallel execution. This extension adds the
ability for an orchestrator LLM to fan out work to parallel pi instances, each
running as a separate process with its own session, coordinating through
file-backed task-tools.

## Design Principles

- No IPC beyond task files + process lifecycle.
- Subagents are regular `pi -p` processes — no special runtime.
- Recursion is prevented (subagents cannot spawn further subagents).
- Task-tools is the semantic coordination layer.
- Process registry is the runtime coordination layer.
- No working directory isolation — subagents share the same cwd.
  Orchestrator is responsible for planning non-conflicting work.

## Tool: `subagent`

Single action-based tool (same pattern as `task` tool).

### Abort Signal

The `AbortSignal` passed to `execute()` is wired to child process lifecycle:
- On abort (user hits escape, orchestrator cancels):
  1. Send SIGTERM to the child process.
  2. After 5s grace, SIGKILL if still alive.
  3. Set status to `"stopped"`.
  4. Return captured output so far.
- This applies to both blocking and background modes.
- For blocking spawns, abort causes the tool call to return early with the
  partial result + `stopped` status.

### Actions

#### `spawn`

Launch a new subagent process.

```ts
subagent({
  action: "spawn",
  prompt: string,           // instruction for the subagent
  taskId?: string,          // auto-prepend task claim context to prompt
  background?: boolean,     // false = blocking (default), true = return immediately
  systemPrompt?: string,    // custom system prompt (default: subagent-tuned prompt)
  model?: string,           // override model (default: orchestrator's model)
  thinking?: string,        // thinking level override
  maxTurns?: number,        // max model turns (safety cap, default: 30)
  timeout?: number,         // wall-clock timeout in seconds (default: 300)
})
```

**Blocking mode** (`background: false`, default):
- Tool call blocks until subprocess exits.
- Returns full captured output + exit code.
- Orchestrator can issue multiple blocking spawns in one turn — pi executes
  tool calls concurrently, so they run in parallel.

**Background mode** (`background: true`):
- Returns immediately with `agentId`.
- Orchestrator uses `status`, `output`, `stop` actions to manage.

**Return (blocking):**
```ts
{
  agentId: string,
  exitCode: number,
  output: string,           // captured stdout (truncated if needed)
  error?: string,           // stderr summary if non-empty
  durationMs: number,
  taskId?: string,          // echoed back if provided
}
```

**Return (background):**
```ts
{
  agentId: string,
  pid: number,
  taskId?: string,
  status: "running",
}
```

#### `status`

Check subagent process state.

```ts
subagent({ action: "status", agentId: string })
```

**Return:**
```ts
{
  agentId: string,
  status: "running" | "completed" | "failed" | "timeout" | "stopped",
  exitCode?: number,        // set when not running
  durationMs?: number,
  taskId?: string,
}
```

#### `output`

Retrieve subagent output. Works for both completed and running agents.

```ts
subagent({
  action: "output",
  agentId: string,
  block?: boolean,          // true = wait for completion (default: false)
  timeout?: number,         // wait timeout in seconds (default: 30)
})
```

**Return:**
```ts
{
  agentId: string,
  status: "running" | "completed" | "failed" | "timeout" | "stopped",
  output: string,           // stdout captured so far (truncated)
  error?: string,           // stderr if any
  exitCode?: number,
  ready: boolean,           // true if process has exited
}
```

#### `stop`

Kill a running subagent.

```ts
subagent({ action: "stop", agentId: string })
```

**Return:**
```ts
{
  agentId: string,
  status: "stopped",
  output?: string,          // whatever was captured before kill
}
```

#### `list`

List all subagents spawned in this session.

```ts
subagent({ action: "list" })
```

**Return:**
```ts
{
  agents: Array<{
    agentId: string,
    status: "running" | "completed" | "failed" | "timeout" | "stopped",
    taskId?: string,
    durationMs?: number,
    exitCode?: number,
  }>
}
```

## Model Defaults

When `model` is not specified in `spawn`, subagents default to a cost-efficient
model rather than the orchestrator's model:

- Anthropic provider → `sonnet` (latest available)
- Other providers → same as orchestrator (no downgrade heuristic)

Orchestrator can always override via `model` param for tasks requiring
stronger reasoning.

## Concurrency Limit

Hard cap on concurrent running subagents: **5** (default).
Configurable via `PI_SUBAGENT_MAX_CONCURRENT` env var.

When limit is reached, `spawn` returns an error telling the orchestrator to
wait for existing agents to finish before spawning more.

## Subprocess Execution

### Command construction

```bash
pi -p "<prompt>" \
  --no-prompt-templates \
  --no-themes \
  --no-session \
  [--system-prompt "<system-prompt>"] \
  [--model <model>] \
  [--thinking <level>] \
  [-e ./extensions/task-tools/index.ts] \
  [-e ./extensions/web-tools/index.ts] \
  [-e <other-discovered-extensions...>]
```

Key flags:
- `-p` for non-interactive mode.
- `--no-session` to avoid session file clutter.
- All discovered extensions are forwarded EXCEPT the subagent extension itself.
- Skills are forwarded (subagents benefit from domain-specific skills).
- `--no-prompt-templates`, `--no-themes` to reduce startup overhead.

### Prompt construction

The orchestrator provides the full prompt. It is the orchestrator's job to give
subagents all the context they need — task details, relevant files, constraints,
scope boundaries.

When `taskId` is provided, a task-claim preamble is prepended:

```
You are a subagent. Claim task #<taskId> and work on it.
When done, update the task status to "completed" with a summary of what you did.

<original prompt>
```

When no `taskId`:

```
You are a subagent.

<original prompt>
```

### System prompt

If `systemPrompt` is provided, it is passed via `--system-prompt`.
Otherwise a default subagent system prompt is used:

```
You are a focused subagent. Complete the given task efficiently.
Do not attempt to spawn subagents. Use available tools to accomplish your work.
When working with tasks, claim them before starting and mark them completed when done.
```

The orchestrator can customize this per-agent to set role, constraints, or scope.

### Environment

```bash
PI_SUBAGENT_DEPTH=1              # recursion prevention
PI_PARENT_SESSION_ID=<id>        # for traceability
PI_SUBAGENT_ID=<agentId>         # self-identification
TASK_LIST_ID=<listId>            # share task list with orchestrator
```

Note: `--no-session` skips session file persistence but still generates an
ephemeral session ID. Subagents can claim tasks via this ID.

### Recursion prevention

On extension init:
1. Check `process.env.PI_SUBAGENT_DEPTH`.
2. If depth >= 1, do NOT register the `subagent` tool.
3. Task-tools and other extensions still register normally.

This means subagents can use tasks, web search, read/write/edit/bash — everything
except spawning further subagents.

## Process Registry

In-memory registry held by the orchestrator extension instance.

```ts
interface SubagentEntry {
  agentId: string               // generated UUID
  pid: number
  taskId?: string
  process: ChildProcess
  status: "running" | "completed" | "failed" | "timeout" | "stopped"
  exitCode?: number
  stdout: string                // buffered, capped at OUTPUT_BUFFER_MAX
  stderr: string                // buffered, capped at OUTPUT_BUFFER_MAX
  startedAt: number
  endedAt?: number
  timeout: number               // wall-clock limit ms
  timeoutTimer?: Timer
}
```

**Output buffer cap:** 100KB per stream (stdout/stderr). Ring-buffer style —
keep last 100KB, discard older content.

**Lifecycle transitions:**
- spawn → `running`
- process exits 0 → `completed`
- process exits non-0 → `failed`
- timeout fires → `timeout` (SIGTERM → 5s grace → SIGKILL)
- stop action → `stopped` (SIGTERM → 5s grace → SIGKILL)

## Cleanup

### On orchestrator exit (normal or crash)

The extension registers cleanup via:
- `process.on("exit", ...)` — sync cleanup, best-effort SIGTERM all running children.
- `process.on("SIGINT", ...)` / `process.on("SIGTERM", ...)` — signal forwarding.

Cleanup procedure:
1. Iterate all registry entries with `status === "running"`.
2. Send SIGTERM to each child process.
3. Set a short grace period (2s).
4. SIGKILL any still alive after grace.
5. Clear timeout timers.

### On subagent timeout

1. Send SIGTERM.
2. After 5s grace, send SIGKILL if still running.
3. Set status to `timeout`.
4. Capture whatever output was buffered.

### Orphan prevention

Subagent processes are spawned with `detached: false` (default). On stop/timeout,
the entire process tree is killed recursively via `pgrep -P` to find all
descendant PIDs, killing bottom-up then the process itself. This prevents
grandchild processes (e.g., bash tool's spawned commands) from becoming orphans.

On orchestrator exit, cleanup handlers SIGTERM all running subagent trees,
with a 2s grace period before SIGKILL.

## Coordination Pattern

### Typical orchestrator flow (blocking, parallel via multi-tool-call)

```
1. Orchestrator plans work, creates tasks:
   task({ action: "create", subject: "Implement auth", ... })  → #1
   task({ action: "create", subject: "Write tests", ... })     → #2
   task({ action: "update", taskId: "2", addBlockedBy: ["1"] })

2. Fan out unblocked work (parallel tool calls in one turn):
   subagent({ action: "spawn", prompt: "...", taskId: "1" })
   subagent({ action: "spawn", prompt: "...", taskId: "3" })
   — both run concurrently, both block, results return together —

3. On completion, check what's unblocked:
   task({ action: "list" })  → #2 now unblocked

4. Fan out next wave:
   subagent({ action: "spawn", prompt: "...", taskId: "2" })

5. Synthesize results.
```

### Background variant

```
1. Create tasks (same as above)

2. Spawn background agents:
   subagent({ action: "spawn", prompt: "...", taskId: "1", background: true })  → agentId: "abc"
   subagent({ action: "spawn", prompt: "...", taskId: "3", background: true })  → agentId: "def"

3. Poll / wait:
   subagent({ action: "output", agentId: "abc", block: true, timeout: 120 })
   — or —
   subagent({ action: "list" })
   task({ action: "list" })  // check semantic status

4. Handle stragglers:
   subagent({ action: "stop", agentId: "def" })

5. Synthesize.
```

### No isolation — orchestrator's responsibility

Subagents share the same working directory. The orchestrator MUST plan work
to avoid file conflicts:
- Assign different files/directories to different subagents.
- Use dependencies (blockedBy) to serialize conflicting work.
- Prefer read-heavy parallel work over write-heavy.

## Stuck Detection

Multiple layers:

1. **maxTurns**: pi's internal model turn limit. Subagent exits when exhausted.
2. **timeout**: wall-clock hard kill from orchestrator side.
3. **Orchestrator polling**: LLM checks `subagent({ action: "list" })` +
   `task({ action: "list" })` to detect no-progress situations.
4. **Manual stop**: orchestrator decides to kill via `subagent({ action: "stop" })`.

## Widget

Multi-line widget above the editor showing live subagent status.
Uses `ctx.ui.setWidget()` with `render()` that reads from the process registry
on each tick (same live-reload pattern as task-tools widget).

### Collapsed (no subagents running)

Hidden — widget is removed via `setWidget(id, undefined)`.

### Active subagents

```
┌ Subagents ──────────────────────────────────────────────────┐
│ ▶ abc  #12 Implement auth      2m 13s  sonnet    pid:42019  │
│ ▶ def  #14 Write API tests     1m 45s  sonnet    pid:42035  │
│ ✓ ghi  #11 Fix lint errors        38s  sonnet    pid:42012  │
│ ✗ jkl  #13 Update migrations   5m 00s  timeout   pid:41998  │
└──────────────────────────────────────────────────────────────┘
```

Columns:
- Status icon: `▶` running, `✓` completed, `✗` failed/timeout/stopped
- Agent ID (short prefix)
- Task ID + subject (if taskId was provided)
- Elapsed / total duration
- Model used
- PID (right-aligned, always shown, useful for debugging even after exit)

### Summary line (no active, some completed)

When all agents are done, collapse to single line:

```
Subagents: 3 completed · 1 failed
```

### Lifecycle

- Widget appears on first `spawn`.
- Shows detailed multi-line view while any agent is `running`.
- Collapses to summary when all done.
- Removed when registry is empty (or orchestrator session ends).

### Interactive `/agents` command

Full interactive panel (same pattern as `/tasks`) for:
- Viewing all agents with details
- Inspecting output of a specific agent
- Stopping a running agent
- Clearing completed entries

Keybindings:
- `j/k` navigate
- `enter/o` view output
- `x` stop agent
- `q/esc` close

## Extension Discovery

The subagent extension needs to know which extensions to forward.
Resolution order:

1. Read `pi.extensions` from `package.json` in cwd.
2. Filter out the subagent extension itself.
3. Resolve paths relative to cwd.

## Limitations

- Subagent depth is hard-capped at 1 (no recursive spawning).
- Output is text-only (no structured data channel beyond task files).
- No shared memory or streaming between orchestrator and subagent.
- Each subagent is a full pi process (startup cost per spawn).
- No working directory isolation — parallel writes can conflict.
- Max 5 concurrent subagents (configurable).

## File Layout

```
extensions/subagent-tools/
  index.ts          # extension entry, registers tool + widget + recursion gate
  subagent.tool.ts  # tool implementation (action dispatch)
  registry.ts       # in-memory process registry + lifecycle
  spawn.ts          # subprocess construction + output capture
  cleanup.ts        # signal handlers + orphan prevention
  types.ts          # shared types
  package.json
  tsconfig.json
  README.md
```

## Open Questions

- [ ] Should subagent stdout be streamed to orchestrator UI in real-time?
- [ ] Output truncation strategy: last N bytes? Or summarize via LLM?
- [ ] Should `--continue` be supported for resumable subagents?

## TODO / Research

### ✅ Evict completed agents from registry
Completed agents are evicted from the registry (and widget) after their output
is consumed: blocking spawns evict immediately after returning; background agents
evict after `output` action reads them or `stop` kills them. Output files remain
on disk until session shutdown.

### ✅ Background agent completion notifications via `before_agent_start`
Pi's `ReadonlySessionManager` (exposed to extensions) does not have
`appendCustomMessageEntry`, so we cannot inject notifications mid-conversation.
Instead, `before_agent_start` event handler checks for completed background
agents and injects a `CustomMessage` with completion status and output file
path. The model sees this on its next turn. Agents are evicted after notification.

### ✅ Write subagent output to temp files
Output is streamed to disk as it arrives (`appendFileSync`) and read back via
`readOutputFile()`. Files live at `/tmp/pi-subagents/<sessionId>/<agentId>.output`.
In-memory buffer is still maintained for quick access (100KB cap). Output files
survive the tool execution context and can be referenced by the `read` tool.
Cleaned up on `session_shutdown`.

### ✅ Show `activeForm` in task widget/UI
Task widget now shows `activeForm` text instead of `#id subject` when the task
is `in_progress` and `activeForm` is set. `/tasks` list view shows `(activeForm)`
suffix on in_progress tasks. Detail view shows `Activity:` field.

### Research: Task status management without worker access
Only the orchestrator manages the task graph. Workers just do work and report via stdout.

Our approach: subagents get task-tools, prompt tells them to claim + update.
This is simpler but lets workers potentially mess with the graph.

Options to investigate:
- Can we selectively exclude extensions from subagent CLI? (e.g., forward all
  extensions except task-tools via `-e` flags)
- If we exclude task-tools, the orchestrator must: set status to in_progress
  before spawning, set status to completed after reading output. Cleaner
  separation but more orchestrator logic and more tool calls.
- Trade-off: prompt-based discipline vs structural enforcement.
- Current prompt preamble ("claim task, set in_progress, mark completed") works
  in practice but is not enforced.

### `/agents` interactive command
Not yet implemented. Spec describes a full interactive panel (like `/tasks`) for
viewing agents, inspecting output, stopping running agents, clearing entries.
Lower priority — `subagent list`/`output`/`stop` actions cover the same ground.

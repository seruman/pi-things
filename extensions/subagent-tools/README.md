# subagent-tools

Subagent extension for pi, with **single**, **parallel**, and **chain** delegation.

## Tool

### `subagent`

Single action tool for delegated subprocess execution.

```ts
subagent({
  // Single mode
  task: string,
  agent?: string,
  cwd?: string,

  // Parallel mode
  tasks?: Array<{ task: string; agent?: string; cwd?: string }>,

  // Chain mode
  chain?: Array<{ agent: string; task: string; cwd?: string }>,

  // Discovery / trust scope
  agentScope?: "user" | "project" | "both",
  confirmProjectAgents?: boolean,
})
```

### Mode rules

Provide exactly one mode:
- single: `task`
- parallel: `tasks[]`
- chain: `chain[]`

Chain mode supports `{previous}` placeholder substitution from the prior step output.

## Defaults

- default single agent: `worker` via `--subagents-default-agent`
- child pi invocation follows the current process when possible, or can be overridden with `PI_SUBAGENT_COMMAND` (legacy `PI_SUBAGENT_BIN` still works for binary-only overrides)
- default `agentScope`: `"user"`
- default `confirmProjectAgents`: `true`
- project-agent approval can be remembered for the current pi session (per project)
- max parallel tasks: `8`
- max concurrent workers: `4`

## Structured completion contract

Each spawned subagent receives an internal `submit_result` tool, injected by the parent extension.

This tool is private to the child subprocess:
- it is provided via the injected internal extension
- it is not added to the child process `--tools` list
- it is not intended to be exposed to the parent agent as a normal selectable tool

Subagents are instructed to close work with exactly one `submit_result` call:
- `status: "success"` with `data`
- `status: "aborted"` with `error`

If a subagent exits without `submit_result`, the parent marks the run as failed.

## Prompt/guidance injection

The extension injects two guidance layers:

1. **Session-level model guidance**
   - one-time hidden guidance message per session
   - controlled by `--subagents-guidance`, default `true`
   - steers model behavior toward large repo-wide exploration, expensive independent work units, one blocking call, parallel batching, and no polling

2. **Child subagent system guidance**
   - per-subprocess appended guidance, includes efficiency constraints and submit_result closure contract

## Agent discovery

Discovered from:
- bundled package agents: `./agents/*.md`
- user agents: `~/.pi/agent/agents/*.md`
- nearest project agents: `.pi/agents/*.md`

Precedence: `project > user > bundled`, same-name agent overrides lower priority.

## Commands

- `/subagents` — list discovered agents
- `/subagents-running [query]` — list recent/running subprocesses for current pi process

## Notes

- Subagent calls are blocking, progress is streamed via tool updates/UI.
- With `agentScope: "project" | "both"` and `confirmProjectAgents: true`, interactive runs show a trust selector: `Allow once`, `Always allow this session`, or `Cancel`.
- Long outputs are truncated in-context and spilled to `.pi/subagent-output/*`.
- Spawned subprocesses run with `--no-extensions --no-skills --no-prompt-templates`, then inject only the internal `submit_result` extension.
- Normal child tool access still comes from the selected agent's configured tool list; `submit_result` is separate from that list.

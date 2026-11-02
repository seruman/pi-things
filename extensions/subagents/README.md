# subagents

Persistent Pi children in minimized floating terminals in Pi’s Rex window. Tools are available through codemode; `/subagent` restores and focuses an active child.

Requirements:

- `rex` available in `PATH`, with floating-layer API support.
- `REX_SESSION` and `REX_BLOCK` set; Pi’s block must be placed in a window.

## Tools

### `agent_spawn`

Launch a child. Waits for its first result unless `background: true`. Children stay alive until stopped.

```ts
agent_spawn({
  prompt: string,
  name?: string,
  cwd?: string,
  provider?: string,             // defaults to parent's provider
  model?: string,                // defaults to parent's model
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  tools?: "readonly" | string[],
  excludeTools?: string[],
  noTools?: "all" | "builtin",
  background?: boolean,          // default false
})
```

### `agent_send`

Prompt an idle child or steer active work. Use `followUp` to queue another turn instead.

```ts
agent_send({
  handle: string,
  message: string,
  followUp?: boolean,
})
```

### `agent_wait`

Wait for a result without stopping the child. Repeated waits do not double-count usage.

```ts
agent_wait({
  handle: string,
  timeoutSec?: number,            // default 1800
})
```

### `agent_stop`

Abort and save available usage before closing. Returns `{ handle, sessionFile }`, keeping history. After a 10-second timeout, retry or force-kill (unsaved usage may be lost).

```ts
agent_stop({ handle: string, force?: boolean })
```

### `agent_list`

List this session’s children. Include stopped children to find retained histories.

```ts
agent_list({ includeStopped?: boolean })
```

### `agent_rename`

Change a child’s display name without changing its handle.

```ts
agent_rename({ handle: string, name: string })
```

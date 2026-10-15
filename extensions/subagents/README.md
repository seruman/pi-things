# subagents

Persistent Pi children in Rex. Tools are available through codemode; `/subagent` attaches to an active child.

Requirements:

- `rex` available in `PATH` and `REX_SESSION` set.

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

Stop the child, keeping its history. Returns `{ handle, sessionFile }`.

```ts
agent_stop({ handle: string })
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

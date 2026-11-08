# subagents

Persistent Pi children in minimized Rex panes. `/subagent` opens a child pane.

Needs `rex` on `PATH` and `REX_SESSION` / `REX_BLOCK` pointing to a pane in a Rex window.

## Tools

Parent tools are available through codemode.

| Tool           | Use                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `agent_spawn`  | Start a child and wait for its answer. Use `background: true` to return immediately.                             |
| `agent_send`   | Send to a child by handle. Wakes idle children or steers busy ones. `followUp: true` queues behind current work. |
| `agent_wait`   | Wait for a child. Default timeout is 1800 seconds.                                                               |
| `agent_stop`   | Stop a child and close its pane. `force: true` skips graceful shutdown.                                          |
| `agent_list`   | List children. `includeStopped: true` includes retained histories.                                               |
| `agent_rename` | Change the display name, not the handle.                                                                         |

Children use `agent_reply` to message their parent.

## Checks

```sh
bun run test:subagents
bun run typecheck:subagents
```

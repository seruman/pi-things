# task-tools

Persistent task tracking extension with markdown + YAML storage and session-based ownership.

## Tool

### `task`

Single action-based tool for all task operations.

```ts
task({ action: "list", includeCompletedBlockers?: boolean })

task({ action: "get", taskId: string, includeCompletedBlockers?: boolean })

task({
  action: "create",
  subject: string,
  description: string,
  activeForm?: string,
  metadata?: Record<string, unknown>,
})

task({
  action: "update",
  taskId: string,
  subject?: string,
  description?: string,
  activeForm?: string,
  status?: "pending" | "in_progress" | "completed" | "deleted",
  addBlocks?: string[],
  addBlockedBy?: string[],
  metadata?: Record<string, unknown>,
})

task({ action: "claim", taskId: string, force?: boolean })

task({ action: "release", taskId: string, force?: boolean })

task({ action: "purge", scope?: "completed" | "all", confirm: boolean })
```

## Command

### `/tasks`

Interactive task browser:

- `j/k` navigate
- `enter/o` details
- `w` work (sets editor prompt)
- `c` clarify (sets editor prompt)
- `b/esc` back
- `q` close

## Storage

Tasks are stored in:

- `.pi/tasks/<TASK_LIST_ID>/<id>.md`
- `.pi/tasks/<TASK_LIST_ID>/.highwatermark`
- `.pi/tasks/<TASK_LIST_ID>/.lock`

`TASK_LIST_ID` defaults to `default` and can be overridden via `TASK_LIST_ID` env var.

## Notes

- Ownership is session-based and controlled via `claim` / `release`.
- Dependency cycles are rejected.
- Broken task files are skipped in list output and reported.
- Locking is file-based with stale-lock recovery.

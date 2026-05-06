# task-tools

Persistent personal task tracking extension with markdown + YAML storage and session-based ownership.

## Tool

### `task`

```ts
task({ action: "list" })

task({ action: "get", taskId: string })

task({
  action: "create",
  subject: string,
  description: string,
})

task({
  action: "update",
  taskId: string,
  subject?: string,
  description?: string,
  status?: "pending" | "in_progress" | "completed" | "deleted",
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

`TASK_LIST_ID` defaults to `default` and can be overridden via env var.

Each task is a markdown file with YAML frontmatter. The markdown body is the task description.

```markdown
---
id: "1"
subject: Example task
status: pending
owner: null
created_at: "2026-05-06T00:00:00.000Z"
updated_at: "2026-05-06T00:00:00.000Z"
---

Task description goes here.
```

## Notes

- Ownership is session-based and controlled via `claim` / `release`.
- Broken task files are skipped in list output and reported.
- Locking is file-based with stale-lock recovery.

# Task Tools Extension — v1 Spec (SQLite + UI)

## 1) Scope

Standalone extension with 4 tools + UI rendering:

- `task_create`
- `task_update`
- `task_get`
- `task_list`

Out of scope (for now):
- subagents / child sessions
- SSE/event streaming
- cross-process notifications

---

## 2) Extension layout

`extensions/task-tools/`

- `index.ts` — register tools
- `db.ts` — sqlite open/init + shared helpers
- `types.ts` — shared TS types + typebox schemas
- `task-create.tool.ts`
- `task-update.tool.ts`
- `task-get.tool.ts`
- `task-list.tool.ts`
- `task-ui.ts` — render functions for all tools
- `README.md`

---

## 3) Storage

Single DB file: `.pi/tasks.db`

SQLite pragmas:
- `PRAGMA journal_mode = WAL;`
- `PRAGMA foreign_keys = ON;`
- `PRAGMA busy_timeout = 3000;`

---

## 4) Data model

### Table: `tasks`

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id      TEXT NOT NULL,
  subject      TEXT NOT NULL,
  description  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed')),
  owner        TEXT,
  active_form  TEXT,
  metadata     TEXT, -- JSON string, nullable
  created_at   INTEGER NOT NULL, -- unix ms
  updated_at   INTEGER NOT NULL  -- unix ms
);
```

### Table: `task_dependencies`

```sql
CREATE TABLE IF NOT EXISTS task_dependencies (
  blocker_id   INTEGER NOT NULL,
  blocked_id   INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  FOREIGN KEY (blocker_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (blocked_id) REFERENCES tasks(id) ON DELETE CASCADE,
  CHECK (blocker_id != blocked_id)
);
```

### Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_tasks_list_id ON tasks(list_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_dep_blocker ON task_dependencies(blocker_id);
CREATE INDEX IF NOT EXISTS idx_dep_blocked ON task_dependencies(blocked_id);
```

---

## 5) List scoping (`list_id`)

Resolution order:
1. `TASK_LIST_ID` env var (if set)
2. fallback `"default"`

Future: wire session/project identity here without changing tool API.

---

## 6) Tool contracts

### `task_create`

Input:
- `subject: string`
- `description: string`
- `activeForm?: string`
- `owner?: string`
- `metadata?: Record<string, unknown>`

Behavior:
- insert row with `status = "pending"`
- return `{ task: { id, subject } }`

### `task_update`

Input:
- `taskId: string` (numeric string)
- optional:
  - `subject`
  - `description`
  - `activeForm`
  - `owner`
  - `status: "pending" | "in_progress" | "completed" | "deleted"`
  - `addBlocks?: string[]` (this task blocks those)
  - `addBlockedBy?: string[]` (those block this task)
  - `metadata?: Record<string, unknown | null>` (null deletes key)

Behavior:
- if `status === "deleted"`: delete task row (deps cascade via FK)
- otherwise update provided fields only
- dependency writes via relation table:
  - `addBlocks`: `INSERT OR IGNORE INTO task_dependencies (blocker_id, blocked_id)`
  - `addBlockedBy`: `INSERT OR IGNORE INTO task_dependencies (blocker_id, blocked_id)` (reversed)
- reject missing referenced task IDs
- return `{ success, taskId, updatedFields, statusChange? }`

### `task_get`

Input:
- `taskId: string`
- `includeCompletedBlockers?: boolean` (default `false`)

Output:
- full task with `blocks: string[]`, `blockedBy: string[]`
- `blockedBy` excludes completed blockers by default
- or `task: null` if not found

### `task_list`

Input:
- `includeCompletedBlockers?: boolean` (default `false`)

Output:
- all tasks in current `list_id`, ordered by `id ASC`
- each task includes: `id`, `subject`, `description`, `status`, `owner?`, `activeForm?`, `metadata?`, `blocks`, `blockedBy`
- `blockedBy` excludes completed blockers by default

---

## 7) UI rendering

### `task_list`

Compact:
```
Tasks: 8 total · 1 in progress · 5 pending · 2 done
```

Expanded (grouped sections):
```
▶ In Progress
  #3 Implement parser

▶ Pending
  #1 Design schema
  #4 Write tests (blocked by #3)
  #5 Add validation

▶ Completed
  #2 Set up project
```

- Rows show `(blocked by #x, #y)` only for active (non-completed) blockers.
- Rows show `(owner: x)` if set.

### `task_get`

Expanded card:
```
Task #3: Implement parser
Status: in_progress
Description: Parse the input DSL into an AST...
Blocked by: #1
Blocks: #4, #5
```

### `task_create`

Compact: `Task #<id> created: <subject>`

### `task_update`

Compact:
- `Updated task #<id>: status, subject` (lists changed fields)
- If moved to `in_progress`: `Now working on #<id>: <subject>`
- If moved to `completed`: `Completed #<id>: <subject>`
- If deleted: `Deleted task #<id>`

---

## 8) Validations

- `taskId` and dependency IDs must be numeric strings.
- deny self-dependency.
- metadata must serialize to JSON.
- subject/description non-empty after trim.
- all multi-statement writes in `BEGIN IMMEDIATE ... COMMIT`.

---

## 9) Error handling

- Not found: structured tool error text, `success: false`.
- SQLite busy/lock: rely on `busy_timeout`; if still fails, return retryable error message.
- Invalid dependency IDs: fail update with clear message.

---

## 10) Future hooks (design for, don't implement)

- `list_id` from session/project context
- extra status (`cancelled`)
- task ordering/position field
- subagent linkage
- event emission
- enforce single in-progress task per list

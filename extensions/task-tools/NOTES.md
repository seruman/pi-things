# Extension API Notes (for task-tools implementation)

## Runtime Environment

- pi runs under **Node.js** via jiti (TypeScript JIT)
- NOT Bun — `bun:sqlite` unavailable
- Need `better-sqlite3` npm package for SQLite
- Extensions loaded via jiti, TypeScript works without compilation

## Extension Entry Point

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
export default function (pi: ExtensionAPI) {
  pi.registerTool(...)
}
```

## Key Imports

| Package | What |
|---------|------|
| `@mariozechner/pi-coding-agent` | `ExtensionAPI`, `ExtensionContext`, `AgentToolResult`, `ToolRenderResultOptions`, `Theme`, `keyHint`, `getMarkdownTheme`, `DynamicBorder` |
| `@sinclair/typebox` | `Type` for tool parameter schemas |
| `@mariozechner/pi-ai` | `StringEnum` for Google-compatible string enums (use instead of `Type.Union`/`Type.Literal`) |
| `@mariozechner/pi-tui` | `Text`, `Box`, `Container`, `Spacer`, `Markdown`, `SelectList`, `matchesKey`, `truncateToWidth`, `visibleWidth`, `Key` |

## registerTool Signature

```ts
pi.registerTool<TParams, TDetails>({
  name: string,
  label: string,
  description: string,
  parameters: TParams,  // TypeBox schema
  async execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
    // onUpdate?.({ content: [...], details: {...} })
    return { content: [...], details: {...}, isError?: boolean }
  },
  renderCall?(args, theme): Component,
  renderResult?(result: AgentToolResult<TDetails>, options: ToolRenderResultOptions, theme: Theme): Component,
})
```

## ToolRenderResultOptions

```ts
{ expanded: boolean, isPartial: boolean }
```

## State Management (Session Persistence)

**Important for branching support:** Store state in tool result `details`, not external files.
Reconstruct state from session branch on load.

```ts
// Reconstruct from session entries
pi.on("session_start", async (_event, ctx) => reconstructState(ctx))
pi.on("session_switch", async (_event, ctx) => reconstructState(ctx))
pi.on("session_fork", async (_event, ctx) => reconstructState(ctx))
pi.on("session_tree", async (_event, ctx) => reconstructState(ctx))
```

**However:** For task-tools, we're using SQLite which is external persistent storage.
This means tasks survive sessions but don't branch with the session tree.
This is intentional — tasks are project-scoped, not session-scoped.

## UI Rendering

### renderCall
- Returns `Component` (usually `Text`)
- `new Text(styledString, paddingX=0, paddingY=0)`
- Box handles outer padding

### renderResult
- `result.details` has typed details
- `options.isPartial` = streaming/in-progress
- `options.expanded` = user toggled expanded view (Ctrl+O)
- Return `Text` or `Markdown` component

### Theme colors (theme.fg)
- `toolTitle` — tool names
- `accent` — highlights
- `success` — green check
- `error` — red
- `warning` — yellow
- `muted` — secondary
- `dim` — tertiary
- `text` — primary text

### keyHint
```ts
import { keyHint } from "@mariozechner/pi-coding-agent"
keyHint("expandTools", "to expand")  // shows keybinding hint
```

## Commands

```ts
pi.registerCommand("name", {
  description: string,
  handler: async (args, ctx: ExtensionCommandContext) => { ... }
})
```

## ctx.ui Methods

- `ctx.ui.notify(msg, "info"|"warning"|"error")` — non-blocking notification
- `ctx.ui.select(title, options)` — selection dialog
- `ctx.ui.confirm(title, message)` — yes/no dialog
- `ctx.ui.custom<T>((tui, theme, keybindings, done) => Component)` — custom UI
- `ctx.ui.setStatus(id, text)` — footer status
- `ctx.ui.setWidget(id, lines|factory, opts?)` — widget above/below editor

## Widget (persistent above editor)

Good for showing task list summary:
```ts
ctx.ui.setWidget("task-status", (tui, theme) => ({
  render: () => [formattedLine],
  invalidate: () => {},
}))
```

## Package Structure

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  },
  "dependencies": {
    "better-sqlite3": "..."
  }
}
```

Run `npm install` in extension dir. jiti resolves `node_modules/` imports.

## StringEnum for Google compat

Use `StringEnum` from `@mariozechner/pi-ai` instead of `Type.Union([Type.Literal()])`:
```ts
import { StringEnum } from "@mariozechner/pi-ai"
const statusParam = StringEnum(["pending", "in_progress", "completed", "deleted"] as const)
```

## Output Truncation

Tools should truncate output. Available:
```ts
import { truncateHead, truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent"
```

## cwd

`ctx.cwd` — current working directory. Use for resolving `.pi/tasks.db` path.

## Key Patterns from todo.ts Example

1. In-memory state reconstructed from session entries
2. `renderCall` shows tool name + args styled
3. `renderResult` supports compact (default) and expanded (Ctrl+O) views
4. `/todos` command shows interactive list via `ctx.ui.custom()`
5. State stored in `details` field of tool results

## For Our Task Extension

- DB path: `path.join(ctx.cwd, ".pi", "tasks.db")` — project-local
- Tasks are project-scoped (persist across sessions, no branching)
- 4 tools: `task_create`, `task_update`, `task_get`, `task_list`
- Optional: `/tasks` command for interactive task list view
- Widget: show task summary above editor

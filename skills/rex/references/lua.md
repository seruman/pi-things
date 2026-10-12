# Lua and status events

Use Lua when several Rex API calls or event handling are clearer in one script.
Keep `-s` and `-b` explicit, and work only in the task's session or on a block
the user asked you to inspect. Server automation does not authorize app/client
actions, configuration changes, or monitoring unrelated sessions.

## Inspect process and status together

```sh
rex do -s "$session" -b "$block" -e '
  local terminal = "com.superlogical.terminal"
  local process, err = rex.block.call(terminal, "process", {})
  if err ~= nil then error(err, 0) end
  local status, err = rex.block.call(terminal, "program_status", {})
  if err ~= nil then error(err, 0) end
  return { process = process, status = status }
'
```

Returned values print as JSON. `rex.args` holds typed `key=value` arguments
passed after a script path. `rex.session.*` fills in the selected session, and
`rex.block.call` defaults to the selected block. Raw `rex.call` requires the
method's explicit IDs; check `rex api describe <method>` before using it.

## Observe status changes for one block

Use native `rex wait --for ...` to wait for process exit. When an interactive
program stays open and reports status, inspect `program_status` instead. For a
bounded stream of future changes, this example prints states from one block:

```sh
rex do -s "$session" -b "$block" --for 30s --fail-fast -e '
  local session, block = rex.session_id, rex.block_id
  rex.on("terminal.program_status_changed", function(ctx, ev)
    if ctx.session_id == session and ctx.block_id == block then
      print(ev.record.state)
    end
  end)
'
```

Start the subscription before the action you want to observe. Events are not a
history: inspect current status before and after a subscription to catch a
retained state whose event you missed. An old `done` record can belong to an
earlier task, and clearing a record can happen at task start. Neither record
removal nor `idle` alone proves success. Verify the task's output or use a unique
completion marker/result file when you need to identify one particular task.

The observer's successful exit only means its observation period ended normally.
It says nothing about whether the program succeeded. Read `blocked.kind` and
`blocked.msg` when attention is needed; do not approve prompts automatically.
No custom watcher is required for these workflows.

## Writing event scripts

`rex.wait(event, filter, seconds)` receives future events and returns `ev, ctx`,
or `nil, "timeout"`. Its filter is `function(ev, ctx)`. `rex.on` uses the opposite
argument order: `function(ctx, ev)`. Filter by the intended session and block
before acting. Event names are not validated, so inspect the block's schemas
rather than guessing a name.

Lua API failures return `nil, err`; check them explicitly. Bound every top-level
`rex.wait`. `rex do --for` limits the handler loop, not top-level waits or sleeps,
and global `--timeout` is not a whole-script deadline. `--fail-fast` stops a
handler script on errors instead of merely logging them and continuing.

Rex uses Lua 5.1. Use decimal escapes such as `"\27"` for ESC, not `\x1b`.
Avoid `io.popen(command, "w")`: on the tested Rex build, writing succeeded but
closing the pipe hung. Prefer running external commands outside Lua. For simple
fixed input, `os.execute("printf %s 'text' | program")` worked in the probe; it
still blocks and needs an outer deadline. Do not interpolate untrusted text.

Scripts execute on the machine invoking `rex do`, even with `-S`. Lua file and
process operations stay local; Rex API calls use the selected server.

Read the [Lua guide](https://www.superlogical.com/rex/docs/automate/lua-scripts.md),
[events guide](https://www.superlogical.com/rex/docs/automate/lua-events.md), or
[API reference](https://www.superlogical.com/rex/docs/reference/lua.md) as needed.
The [llms.txt index](https://www.superlogical.com/rex/docs/llms.txt) links the rest.

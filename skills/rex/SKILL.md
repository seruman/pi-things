---
name: rex
description: Runs persistent shells, dev servers, long-running commands, and interactive programs in Rex. Use for terminal input and output, process or status waits, and explicitly requested terminal inspection. Prefer Rex over ht/hauntty or tmux when available; ordinary non-interactive commands do not need it.
---

# Rex

Run work through the `rex` CLI in a session created for the current task. Keep
that session separate from the user's terminals, and use the IDs returned by
Rex to address it. The examples below use `jq` to extract those IDs.

## Respect ownership

Leave the user's terminals alone unless they ask you to use them. This includes
reading their output, typing into them, interrupting processes, and changing or
closing their blocks. Permission to inspect logs does not include permission
to restart the server. Visibility is not permission, and a request to run tests
does not authorize using the user's shell. Ask when the requested target is unclear.

For an explicit inspection request, read only the named block, not its neighbors.
Use the requested session's block metadata to resolve its ID if needed; ask if
several targets match. The workspace-creation recipe below is for new work.

Reuse a session only when you recorded creating it for this task. A matching
label, directory, or process name does not establish ownership. Never close the
block hosting this agent. If the user takes over a block you created, leave it
to them.

The Rex app belongs to the user. Keep app/client actions, focus changes,
keybindings, configuration, and server administration outside this workflow.
Do not attach or switch their view. Lua scripts have the same boundaries as CLI
commands. Leave secret entry and sensitive prompts to the user.

## Create a workspace

Rex sessions contain windows, and windows contain terminal blocks. Start a
session with a task-specific label and an explicit working directory:

```sh
response=$(rex new "agent-task-$(uuidgen | tr -d '-')" --cwd "$PWD" --json) &&
session=$(printf '%s\n' "$response" | jq -er '.session_id') &&
anchor=$(printf '%s\n' "$response" | jq -er '.initial_windows[0].block_ids[0]')
```

Continue only if creation and ID extraction succeed. Save the full IDs for later
commands; shell variables may not survive between invocations. Labels are CLI
handles, while the title displayed in a block can come from its program.

Pass `-s "$session"` when addressing blocks, even by full ID. Rex resolves them
within a session. The ambient `REX_SESSION` and `REX_BLOCK` usually identify the
agent's host terminal, not the workspace just created. Use `rex whoami --json`
when you need to establish the server and ambient location. Keep the same server
selection (`-S` if specified) on later calls. Do not fall back to ambient IDs or
the focused block when an explicit target fails.

Inspect the task's workspace with explicit targets:

```sh
rex block ls -s "$session" --json
rex block call -s "$session" -b "$anchor" process
rex capture -s "$session" -b "$anchor" --trim --unwrap | tail -n 80
```

## Run a command and collect its result

For a build or test run, start the command directly in a new block. This lets
Rex report its exit status. Replace `make test` with the project's command:

```sh
response=$(rex run -s "$session" --cwd "$PWD" --label tests \
  --focus=false --keep-open --json -- make test) &&
block=$(printf '%s\n' "$response" | jq -er '.block_ids[0]')
```

After creation succeeds, wait with a deadline and inspect the result:

```sh
rc=0
rex wait -s "$session" --for 2m "$block" || rc=$?
printf 'wait status: %s\n' "$rc"
rex capture -s "$session" -b "$block" --trim --unwrap | tail -n 80
rex block call -s "$session" -b "$block" process
```

`--keep-open` retains the terminal after exit. `wait` returns the child's exit
status, but a nonzero result can also mean a timeout or Rex error. Read the
diagnostics and `process.last_exit` before deciding which occurred. A timeout
does not stop the process. Use `--for` to bound the wait; global `--timeout`
only limits connections and individual requests.

`rex run` adds a window. To create a split within the task's session instead:

```sh
response=$(rex split -s "$session" -b "$anchor" --split=below --ratio 30 \
  --cwd "$PWD" --focus=false --keep-open --json -- make test) &&
block=$(printf '%s\n' "$response" | jq -er '.block_ids[0]')
```

Command arguments are not shell syntax. Use an explicit shell for pipes,
redirects, or `&&`, such as `-- sh -c 'make test >test.log 2>&1'`. Commands use
the login shell's environment, not its interactive aliases.

## Start a server and verify readiness

Launch the project's server command in its own block:

```sh
response=$(rex run -s "$session" --cwd "$PWD" --label dev-server \
  --focus=false --keep-open --json -- npm run dev) &&
block=$(printf '%s\n' "$response" | jq -er '.block_ids[0]')
```

Capture startup output first. Set `$url` to the URL or health endpoint whose
successful bind this process reported, not merely its configured or usual port.
If it reports a bind error, inspect that failure instead of probing the other
service. Then check readiness while also checking that this process is alive:

```sh
ready=false
for attempt in $(seq 1 30); do
  process=$(rex block call -s "$session" -b "$block" process) || break
  printf '%s\n' "$process" | jq -e '.last_exit == null and .child != null' >/dev/null || break
  if curl --fail --silent --max-time 1 "$url" >/dev/null; then
    ready=true; break
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  rex capture -s "$session" -b "$block" --trim --unwrap | tail -n 80
fi
```

Adjust the retry bound to the project's startup time. When the endpoint reports
an instance or build identity, check that too. A live process and an HTTP response
alone do not establish which process owns the port. Do not stop that service to free its
port without permission. `rex wait` waits for a process to exit, not become
ready. Leave a requested dev server running and report its URL and session ID.

## Use a persistent shell or interactive program

The initial `$anchor` block runs a persistent shell. Before sending input,
inspect its process and output to confirm that it is ready. The child can be a
`login` wrapper, so check the foreground process to identify the actual shell.
Use that shell's syntax rather than assuming it matches the shell invoking Rex.

```sh
rex send -s "$session" -b "$anchor" -- 'export APP_ENV=test' &&
rex send-key -s "$session" -b "$anchor" enter
rex capture -s "$session" -b "$anchor" --trim --unwrap | tail -n 80
```

`send` inserts text without Enter. Chain Enter after a successful send, and
serialize input to each block. Embedded newlines can be treated as bracketed
paste rather than submission. A TUI may need a short pause between paste and
Enter. Inspect before retrying input: a timeout does not prove it was lost.

For a REPL or debugger, launch the program directly with `rex run`, wait for its
expected prompt, then send one input and inspect the response. A newly created
terminal is not necessarily ready. Shell commands belong at a shell prompt,
not in an editor, pager, or unrelated program.

On a persistent shell, `rex wait` tracks the shell's exit, not each command typed
into it. When preserving shell state matters, append a unique completion marker
and the command's status. This example is for a POSIX-like shell:

```sh
marker="__rex_done_$(uuidgen | tr -d '-')"
rex send -s "$session" -b "$anchor" -- "make test; printf '\\n${marker}:%s\\n' \"\$?\"" &&
rex send-key -s "$session" -b "$anchor" enter
```

For fish, send this instead; `$status` must be evaluated by the target shell:

```sh
rex send -s "$session" -b "$anchor" -- "make test; printf '\\n${marker}:%s\\n' \"\$status\"" &&
rex send-key -s "$session" -b "$anchor" enter
```

Poll captures with a deadline for a line matching `^<marker>:[0-9]+$`.
Match the printed status,
not the echoed command. A quiet screen or familiar prompt does not prove success.
Prefer a direct command block when no prepared shell state is needed.

## Read output and program status

`capture` includes retained scrollback; limit routine reads with `tail`, then
widen the capture if the relevant failure occurred earlier. A full-screen program
using the alternate screen exposes its current screen, not a complete transcript.
Use file output when you need a durable result.

For programs that report Rex status:

```sh
rex block call -s "$session" -b "$block" program_status
```

Records can report `idle`, `working`, `done`, `blocked`, or `error`. A blocked
record's `kind` and `msg` can explain what is needed. These are program reports,
not exit codes or permission to approve another action.

For a program that stays open between tasks, inspect its status before sending
new work and confirm it accepted that work. An old `done` record, an `idle` state,
or a cleared record alone does not prove the new task succeeded. Check its output
or a task-specific result. `rex wait` remains the choice for process exit.

Read [Lua and status events](references/lua.md) when several API calls or a bounded
event subscription would be useful. There is no custom wait helper to install.
Observe only task-owned blocks or a specific block the user asked you to inspect.

## Finish or hand off

Leave work running when the user needs it. Report the session label and ID;
they can open it with `rex attach "$session"`. Keep `--focus=false` on new work
rather than changing their view.

To interrupt a task-owned process, send `ctrl+c` and inspect the effect:

```sh
rex send-key -s "$session" -b "$block" ctrl+c
rex capture -s "$session" -b "$block" --trim --unwrap | tail -n 80
```

Once its output is no longer needed, `rex block close -s "$session" "$block"`
closes that block. If the user has taken over any block, preserve its session;
close only other disposable blocks this task owns. Before `rex kill "$session"`,
confirm that nothing in the session should remain. Use only the ID recorded at
creation; never clean up by label prefix or kill every session.

## Troubleshoot and extend

A CLI exit of `3` means a missing or ambiguous target. Check the saved IDs and
session scope rather than falling back to focus. Exit `4` means the server could
not be reached. Check the endpoint and diagnostics; a denied socket connection
may require permission, not a server restart or an attempt to bypass restrictions.
Use `--autostart=false` when a diagnostic command should not start a server.
These codes can also be a child's own exit status from `wait`, so consult
`process.last_exit` and diagnostics before interpreting them.

For user-requested work on another machine, read [Remote work](references/remote.md).
Keep the selected server, session ID, and block ID together. Do not configure
hosts or expose a server as part of running a job.

Use `rex <command> --help` for exact flags, `rex api describe <method>` for server
methods, and `rex block inspect -s "$session" "$block" --json` for block schemas.
Start documentation lookup at [llms.txt](https://www.superlogical.com/rex/docs/llms.txt)
and fetch the relevant `.md` page. Rex has its own targeting and waiting semantics;
do not substitute tmux or hauntty flags.

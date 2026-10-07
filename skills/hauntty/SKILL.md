---
name: hauntty
description: Use hauntty/ht for persistent terminal sessions. Use when commands need persistent shell state, long-running processes, human attach/detach, interactive terminal workflows, screen dumps, scrollback inspection, or waiting for terminal output.
---

# hauntty

Use `ht`, the hauntty CLI, to drive persistent terminal sessions from Pi's normal `bash` tool.

hauntty is a terminal session daemon, not a task runner. Prefer terminal primitives: create/attach sessions, send text or keys, wait for screen content, and dump the screen/scrollback.

## When to use

Use hauntty instead of one-shot `bash` when any of these matter:

- shell state should persist across commands (`cwd`, exported env, activated venv/dev shell)
- a server, watcher, REPL, debugger, or TUI should keep running
- the user may need to attach and interact manually, e.g. password prompts
- terminal screen state or scrollback is useful context
- commands should run in a real PTY rather than non-interactive shell

Do not use hauntty for simple non-interactive commands where `bash` is enough.

## Mental model

- A session is a named shell/PTY managed by the hauntty daemon.
- When a session's process ends, hauntty can keep saved terminal state under that session name for later inspection or restore.
- `ht new` creates a session without attaching.
- `ht send` types bytes or keys into an existing session.
- `ht wait` polls the current plain screen until text/regex appears.
- `ht dump` reads the screen, optionally including scrollback.
- `ht attach` is for the human to enter the terminal directly.
- The daemon auto-starts for `attach`, `new`, or `restore`; inspection commands require a running daemon.

## Core commands

```bash
ht new <session> [command ...]              # create/start without attaching
ht attach <session> [command ...]           # attach, creating if needed
ht attach -r <session>                      # read-only attach
ht send <session> '<text>'                  # send literal text, no implicit Enter
ht send <session> --key enter               # send a key
ht send <session> --key ctrl+c              # send modified key
ht wait <session> '<text>'                  # wait for substring on screen
ht wait -e <session> '<regex>'              # wait for regex
ht dump <session>                           # current plain screen
ht dump -S <session>                        # include scrollback
ht dump -J -S <session>                     # include scrollback and join soft wraps
ht list                                     # live sessions
ht list --all                               # live and dead sessions
ht status                                   # daemon/session status
ht kill <session>                           # kill session
ht restore <session>                        # restore saved state and attach
ht new -f <session> [command ...]           # discard saved state for that name and create
ht prune                                    # remove saved state for ended sessions
```

Global options:

```bash
ht --socket <path> ...        # override daemon socket
HAUNTTY_SOCKET=<path> ht ...  # same via env
```

## Sending text and keys

`ht send` does not add a newline. To run a shell command, include a newline in the text or send Enter separately.

Prefer `printf`/ANSI-C quoting for newlines and special characters:

```bash
ht send dev $'npm test\n'
ht send dev 'npm test'
ht send dev --key enter
```

Multiple text arguments are sent in order as separate byte chunks; multiple `--key` flags are sent in order after text chunks.

Key notation is case-insensitive. Supported modifiers:

- `ctrl` / `control`
- `shift`
- `alt` / `opt` / `option`
- `super` / `cmd` / `command`

Supported named keys:

- `enter` / `return`
- `escape` / `esc`
- `tab`, `backspace`, `space`
- arrows: `up`, `down`, `left`, `right`
- `home`, `end`, `pageup` / `pgup`, `pagedown` / `pgdn`
- `insert`, `delete` / `del`
- `f1` through `f12`
- printable single characters, e.g. `a`, `]`, `/`

Examples:

```bash
ht send dev --key ctrl+c
ht send dev --key ctrl+shift+z
ht send dev --key cmd+p
ht send dev --key up --key enter
```

## Waiting and dumping

`ht wait` checks the plain current screen, not full scrollback. Defaults:

- substring match, not regex
- timeout: `30000` ms
- interval: `100` ms
- all rows unless `--row` is set

Examples:

```bash
ht wait dev 'Compiled successfully'
ht wait -t 120000 dev 'ready'
ht wait -e dev 'Tests:.*passed'
ht wait --row 0 dev 'server running'
```

After a wait, inspect output with `dump`:

```bash
ht dump dev
ht dump -S dev
ht dump --format vt -S dev
ht dump --format html -S dev
```

Formats:

- `plain` default, best for agent reading
- `vt` preserves terminal escape state
- `html` renders terminal screen as HTML

Use `-J` / `--join` when soft-wrapped lines make output hard to read.

## Common workflows

### Start a persistent shell

```bash
ht new dev /bin/sh
ht send dev $'cd /path/to/project\n'
ht send dev $'export FOO=bar\n'
ht dump dev
```

### Run tests in an existing prepared session

```bash
ht send dev $'go test ./...\n'
ht wait -t 120000 dev '$ '
ht dump -S dev
```

If the prompt is unknown, wait for distinctive command output instead of a prompt.

### Start a long-running server

```bash
ht new web /bin/sh
ht send web $'cd /path/to/project\nnpm run dev\n'
ht wait -t 120000 web 'Local:'
ht dump -S web
```

Do not use a blocking `bash` command for a long-running server when hauntty is available.

### Human-in-the-loop interaction

If a password prompt, OAuth flow, TUI, debugger, or other interactive step appears, ask the user to attach:

```bash
ht attach <session>
```

Tell the user the detach key from config. Default is `ctrl+;`:

```bash
ht config
```

For observation-only access:

```bash
ht attach -r <session>
```

After the user detaches, continue with:

```bash
ht wait <session> '<expected output>'
ht dump -S <session>
```

## Session naming

Use stable, descriptive names. Good patterns:

- repo or task names: `hauntty-dev`, `pi-things-tests`, `web-server`
- include role when multiple sessions are needed: `app-server`, `test-runner`, `repl`

Before creating a new session, check existing sessions if reuse is plausible:

```bash
ht list --all
```

Names shown as ended/saved by `ht list --all` are still meaningful: `ht dump <name>` can inspect them and `ht restore <name>` can bring them back. If you intend to reuse that exact name for a fresh process, use `ht new -f <name> ...` only after deciding the saved state is no longer needed.

Avoid killing sessions unless the user asked, the session is clearly yours for the current task, or cleanup is safe.

## Exit codes and errors

- `ht wait` exits `0` on match, `1` on timeout, `2` on connection/session errors.
- `ht send` fails if no text/key input is provided.
- `ht dump` without a name only works inside a hauntty session via `HAUNTTY_SESSION`; otherwise pass the session name.
- Creating or attaching with a name that has saved state fails with guidance to `ht restore <name>` or `ht new -f <name> ...`.
- If the daemon is not running, `ht list`, `ht status`, `ht send`, `ht wait`, and `ht dump` may fail with a Unix socket connection error. Start a session with `ht new` or `ht attach`.

## Safety and agent behavior

- Be explicit that hauntty sends input to a live terminal. It can trigger arbitrary commands already queued at the prompt.
- Always include the session name in commands unless intentionally relying on `HAUNTTY_SESSION`.
- Prefer `ht dump` before sending potentially destructive keys like `ctrl+c`, `ctrl+d`, or `enter` into unknown state.
- Do not assume the shell prompt string. Wait for known output when possible.
- Do not synthesize hidden task-runner semantics unless explicitly needed. If you need command completion markers, explain the marker approach before using it.
- Prefer the normal `bash` tool for simple filesystem inspection, grep, builds that can run to completion, and other non-interactive commands.

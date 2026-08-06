---
name: teteyectl
description: Control and inspect a running Teteye terminal through its teteyectl CLI. Use when the user asks to create, focus, resize, rename, move, or close Teteye windows, tabs, or panes; run a command in a new pane; inspect terminal topology or contents; or automate Teteye layout for another tool.
---

# teteyectl

Use the installed `teteyectl` command to control the running Teteye instance over
its Unix socket. Prefer documented subcommands over raw `teteyectl ipc` calls.
Run `teteyectl help <subcommand>` when exact flags are needed.

## Safety And Targeting

- Start with `teteyectl context --json` and `teteyectl topology --json`.
- Use returned pane, tab, and window IDs explicitly for every mutating command.
  Do not rely on whichever pane happens to be focused.
- `TETEYE_SOCKET` selects the Teteye instance and `TETEYE_PANE_ID` identifies the
  ambient pane. These remain available to agent tool processes even when
  `tty` reports no TTY.
- Before sending input or reading contents, inspect the pane with
  `teteyectl get-pane --pane <id> --json`. Stop if the pane cannot be verified
  or when `password_input` or `secure_input` is true.
- Never send passwords, tokens, private keys, or other secrets through
  `send-text`, and do not dump a sensitive pane.
- Never close the agent's ambient pane. Close another pane, tab, or window only
  when the user requested it or when cleaning up a pane created by this task.
- Track IDs returned by creation commands; do not rediscover destructive targets
  by title alone.

## Inspect Context And Topology

```bash
teteyectl context --json
teteyectl topology --json
teteyectl list-windows --json
teteyectl list-tabs --json
teteyectl list-panes --json
```

The ambient source pane is normally:

```bash
source_pane=${TETEYE_PANE_ID:-$(teteyectl context --json | jq -er '.result.pane_id')}
```

Inspect exact objects with `get-window`, `get-tab`, and `get-pane` plus an
explicit target ID.

## Create A Pane And Run A Command

Capture the new pane ID from the split response:

```bash
response=$(teteyectl split right --pane "$source_pane" --json)
new_pane=$(jq -er 'select(.ok == true) | .result.pane_id' <<<"$response")
```

A new pane starts its normal shell. Inspect it before sending input and fail
closed if Teteye reports password or secure input, or if its state cannot be
verified:

```bash
pane_state=$(teteyectl get-pane --pane "$new_pane" --json)
if ! jq -e \
  '.ok == true and .result.password_input == false and .result.secure_input == false' \
  <<<"$pane_state" >/dev/null; then
  echo "refusing to send input to an unverified or secure pane" >&2
  exit 1
fi
```

`send-text` inserts text but does not press Enter. Quote dynamic arguments
without assuming the target pane uses Bash, then send the command and Enter
separately:

```bash
argument='value with spaces'
quoted_argument=$(jq -rn --arg value "$argument" '$value | @sh')
command="exec some-command $quoted_argument"
teteyectl send-text "$command" --pane "$new_pane" --json
teteyectl send-keys enter --pane "$new_pane" --json
```

Never interpolate untrusted text as shell syntax. The pane surface can take a
moment to initialize; if `send-text` reports that it is unavailable, wait
briefly and retry the same explicit pane ID. If launch fails and cleanup is
appropriate, request closure only for the newly created pane:

```bash
teteyectl close-pane --pane "$new_pane" --json
```

Teteye warns before closing a pane that still has a running program. Do not
bypass that warning or retry after the user rejects it. An `ok` response means
the close request was accepted, not necessarily that the pane closed; verify
that the exact pane ID is absent afterward.

Use `exec` when the launched process should own the pane. Omit it when the shell
should remain after the command finishes.

## Pane And Tab Operations

```bash
teteyectl focus-pane --pane <pane-id> --json
teteyectl focus-pane right --pane <pane-id> --json
teteyectl resize-pane right 5 --pane <pane-id> --json
teteyectl equalize-panes --pane <pane-id> --json
teteyectl swap-pane left --pane <pane-id> --json
teteyectl zoom-pane --pane <pane-id> --json
teteyectl rename-pane <name> --pane <pane-id> --json
teteyectl close-pane --pane <pane-id> --json

teteyectl new-tab --window <window-id> --json
teteyectl focus-tab --tab <tab-id> --json
teteyectl move-tab --direction right --tab <tab-id> --json
teteyectl rename-tab <name> --tab <tab-id> --json
teteyectl close-tab --tab <tab-id> --json

teteyectl new-window --json
teteyectl focus-window --window <window-id> --json
teteyectl close-window --window <window-id> --json
```

Creation commands return named IDs under `.result`, such as `.result.pane_id`,
`.result.tab_id`, or `.result.window_id`. Read the response rather than
inferring the new object from focus or ordering.

## Terminal Input And Output

```bash
teteyectl send-text "text without Enter" --pane <pane-id> --json
teteyectl send-keys enter --pane <pane-id> --json
teteyectl send-keys ctrl+c --pane <pane-id> --json
teteyectl dump --scope viewport --format text --pane <pane-id> --json
```

Common key tokens include `enter`, `tab`, `escape`, `up`, `down`, `left`,
`right`, `home`, `end`, `pageup`, `pagedown`, `f1` through `f12`, and
`ctrl+<key>`.

Prefer a viewport text dump. Request scrollback or ANSI/HTML only when needed,
and keep extracted output bounded. After sending a command, verify the pane with
`get-pane` or a targeted dump instead of assuming the input succeeded.

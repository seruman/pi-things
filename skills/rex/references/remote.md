# Remote work

Use this only when the user requests work on another machine. Select an already
configured host label or server endpoint; ask if the intended host is unclear.
Do not add hosts, enable remote access, or alter the server's network settings.
A separate Rex session isolates terminals, not filesystem or network permissions.

## Run a job in an owned remote session

Set `$server` to the requested host/endpoint and `$remote_dir` to a directory on
that machine. This creates a new session whose initial block runs the job:

```sh
response=$(rex -S "$server" new "agent-tests-$(uuidgen | tr -d '-')" \
  --cwd "$remote_dir" --keep-open --json -- make test) &&
session=$(printf '%s\n' "$response" | jq -er '.session_id') &&
block=$(printf '%s\n' "$response" | jq -er '.initial_windows[0].block_ids[0]')
```

Stop on creation or parsing failure. Record **all three** identifiers. Keep
`-S` and `-s` on subsequent calls; local `REX_*` context is not this workspace.

```sh
rc=0
rex -S "$server" wait -s "$session" --for 5m "$block" || rc=$?
rex -S "$server" capture -s "$session" -b "$block" --trim --unwrap | tail -n 80
rex -S "$server" block call -s "$session" -b "$block" process
```

The command and its `--cwd` run on the remote host. A path in captured output is
there too; reading the same path locally does not retrieve that file. A URL such
as `127.0.0.1:3000` refers to the remote machine from the server's perspective.
Do not probe an unrelated local service and call the remote server ready.

For Lua inspection or events, use `rex -S "$server" do -s "$session" -b "$block"`
with the script or inline code. The Lua script itself executes locally: its
`io`/`os` operations are local, while Rex API calls use the selected server.

After inspecting the result, close only this recorded session if it is no
longer needed:

```sh
rex -S "$server" kill "$session"
```

Leave requested servers or user-adopted work running. Report the server and
session ID so the user can find it. Never clean up sessions by name prefix.

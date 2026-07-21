# Pi Safety

Pi Safety is a macOS extension that makes Pi safer to use on local projects.

Pi itself runs normally. By default, each model-issued Bash command runs in a new macOS sandbox. Bash can change files in the current project and `/tmp`, but it cannot change files elsewhere unless a supported tool needs a specific location. Supported integrations include Nix-executable-only access to the exact Nix daemon socket and `${XDG_CACHE_HOME:-$HOME/.cache}/nix`.

Pi's built-in `read`, `write`, and `edit` tools still work normally. Pi Safety checks their file paths before they run. It blocks access to secrets such as `.env` files, private SSH keys, cloud credentials, and Pi authentication data. It also prevents changes to Git hooks, shell startup files, and other sensitive settings.

The complete default policy is listed in evaluation order in `default-policy.ts` with simple `noAccess`, `readOnly`, `readWrite`, and snapshot-exclusion rules. The policy is assembled once. Built-in tools interpret it, and the Seatbelt profile is emitted from the same rules. Movement protection, snapshots, and diagnostics use that policy too. Use `/pi-safety policy` to inspect the resolved ordered rules for the current session.

Before the first command that can change files in a request, Pi Safety creates a fast APFS snapshot of the project. It records the checkpoint as session metadata without sending it to the model. The snapshot manifest stores the Pi session ID, while snapshots created outside Pi are marked as standalone. It creates only one snapshot per request and keeps up to 20 snapshots for each project. Generated folders such as `.git`, `.wb`, `node_modules`, `dist`, and `target` are not included.

The `pi-snapshot` command can list, inspect, verify, export, and restore snapshots. It can compare a snapshot with the live project or with another snapshot. Its list reports the sum of per-entry bytes APFS says would be freed immediately. Restore starts as a dry run. Use `--apply` when you want it to change files.

Projects can list extra secret paths in `.pi/pi-safety.json`:

```json
{
  "version": 1,
  "protectedPaths": ["secrets/**", "config/private.json"]
}
```

Use `/pi-safety add [path]` to add a confirmed read-only or read-write directory for the current session; read-write directories are explicitly not checkpointed. `/pi-safety remove [path]` revokes one. Headless sessions can set `PI_SAFETY_SESSION_PATHS` to strict JSON such as `[{"path":"/absolute/repo","access":"read-write"}]`; project `.pi/pi-safety.json` remains tighten-only.

Use `/pi-safety` in TUI mode to inspect session status and, after an explicit warning, disable Bash Seatbelt for the rest of the current Pi session. This human-only maintenance escape hatch leaves checkpoints, built-in tool guards, and the standalone Shell Leash active, but model-issued Bash receives the user's full permissions. The bypass cannot be switched back on inside the same extension instance because unsandboxed Bash could tamper with trusted runtime state; use `/reload` or start a new Pi session to restore Seatbelt safely. Use `/pi-safety status` for text status and `/pi-safety policy` for the resolved policy.

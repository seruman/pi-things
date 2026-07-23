# Pi Safety

Pi Safety provides two independent session features on macOS:

- **Filesystem protection**, disabled by default, applies one ordered policy to model-issued Bash through Seatbelt and to Pi's built-in `read`, `write`, and `edit` tools.
- **APFS checkpoints**, enabled by default, create one lazy project checkpoint before the first mutating tool call in each agent turn.

Use `/pi-safety` to toggle either feature immediately. Protection can also start enabled in a headless session with `PI_SAFETY_PROTECTION=1`.

## Filesystem protection

When enabled, the host and HOME are read-only by default and the workspace is read-write. Standard writable tool locations include the macOS and XDG cache roots, npm and Bun caches, all of `~/.cargo`, default or configured GOPATH `pkg` directories, the configured temporary container, `/private/tmp`, `~/.xdg`, and `~/Library/Keychains`. Mach service lookup is unrestricted. Keychain item ACLs still determine which credentials a program may access.

Private SSH material, `~/.env`, `~/.netrc`, `~/.gitcookies`, `~/.config/opnix`, cloud credentials, Pi authentication data, project `.env` conventions, snapshot protected storage, and configured project secrets remain inaccessible. Public SSH keys and ordinary SSH client metadata remain readable.

The complete policy is listed in evaluation order in `default-policy.ts`. Use `/pi-safety policy` to inspect the resolved rules for the current session. `/pi-safety add [path]` grants a confirmed read-only or read-write session directory; `/pi-safety remove [path]` revokes one. Read-write session paths are not checkpointed. Headless sessions can set `PI_SAFETY_SESSION_PATHS` to strict JSON such as `[{
  "path": "/absolute/repo",
  "access": "read-write"
}]`.

When protection is disabled, Bash and built-in file tools run with the user's ordinary permissions. Checkpoints remain independent and continue to classify policy-denied files as protected snapshot entries, but unsandboxed Bash can access user-owned state directly.

## Checkpoints

Before the first Bash, `write`, or `edit` call in a turn, Pi Safety creates a fast APFS snapshot when checkpoints are enabled. It records the checkpoint as session metadata without sending it to the model, keeps up to 20 snapshots per project, and excludes generated directories such as `.git`, `.pi`, `.wb`, `node_modules`, `dist`, and `target`.

The `pi-snapshot` command can create, list, inspect, verify, compare, export, garbage-collect, and restore snapshots. Restore starts as a dry run; use `--apply` to mutate the project.

Projects can tighten protected paths in `.pi/pi-safety.json`:

```json
{
  "version": 1,
  "protectedPaths": ["secrets/**", "config/private.json"]
}
```

Project configuration cannot grant additional filesystem authority.

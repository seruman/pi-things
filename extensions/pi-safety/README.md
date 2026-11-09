# Pi Safety

Pi Safety applies an ordered policy to model-issued Bash and Pi's built-in `read`, `write`, and `edit` tools on macOS. Protection is disabled by default. Use `/pi-safety` to toggle it, or start with `PI_SAFETY_PROTECTION=1`.

## Seatbelt

When enabled, the host and HOME are read-only by default and the workspace is read-write. Standard writable tool locations include the macOS and XDG cache roots, npm and Bun caches, all of `~/.cargo`, default or configured GOPATH `pkg` directories, the configured temporary container, `/private/tmp`, `~/.xdg`, and `~/Library/Keychains`. Mach service lookup is unrestricted. Keychain item ACLs still determine which credentials a program may access.

Linked Git worktrees and submodules resolve hooks and configuration through their gitfile, including shared Git configuration and per-worktree `config.worktree`.

Private SSH material, `~/.env`, `~/.netrc`, `~/.gitcookies`, `~/.config/opnix`, cloud credentials, Pi authentication data, project `.env` conventions and configured project secrets remain inaccessible. Public SSH keys and ordinary SSH client metadata remain readable.

The complete policy is listed in evaluation order in `default-policy.ts`. In `/pi-safety`, press `p` to browse the resolved Seatbelt ACL read-only, or use `/pi-safety policy` for its text form. `/pi-safety add [path]` grants a confirmed read-only or read-write session directory; `/pi-safety remove [path]` revokes one. Headless sessions can set `PI_SAFETY_SESSION_PATHS` to strict JSON such as `[{
  "path": "/absolute/repo",
  "access": "read-write"
}]`.

When Seatbelt is disabled, Bash and built-in file tools run with the user's ordinary permissions.

Projects can tighten protected paths in `.pi/pi-safety.json`:

```json
{
  "version": 1,
  "protectedPaths": ["secrets/**", "config/private.json"]
}
```

Project configuration cannot grant additional filesystem authority.

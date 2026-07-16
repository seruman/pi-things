# Pi Safety

Pi Safety is a macOS extension that makes Pi safer to use on local projects.

Pi itself runs normally. Each Bash command runs in a new macOS sandbox. Bash can change files in the current project, but it cannot change files elsewhere unless a supported tool needs a specific location.

Pi's built-in `read`, `write`, and `edit` tools still work normally. Pi Safety checks their file paths before they run. It blocks access to secrets such as `.env` files, private SSH keys, cloud credentials, and Pi authentication data. It also prevents changes to Git hooks, shell startup files, and other sensitive settings.

The complete default policy is listed in evaluation order in `default-policy.ts` with simple `noAccess`, `readOnly`, `readWrite`, and snapshot-exclusion rules. The policy is assembled once. Built-in tools interpret it, and the Seatbelt profile is emitted from the same rules. Movement protection, snapshots, and diagnostics use that policy too. Use `/pi-safety policy` to inspect the resolved ordered rules for the current session.

Before the first command that can change files in a request, Pi Safety creates a fast APFS snapshot of the project. It records the checkpoint as session metadata without sending it to the model. The snapshot manifest stores the Pi session ID, while snapshots created outside Pi are marked as standalone. It creates only one snapshot per request and keeps up to 20 snapshots for each project. Generated folders such as `.git`, `.wb`, `node_modules`, `dist`, and `target` are not included.

Shell Leash guards remote Git and GitHub mutations inside model Bash. It asks before a known mutation and supports one-call or request-scoped approval. Focused `git` and `gh` shims reject mutations that become visible only after shell expansion. Unknown cases are recorded as hidden session metadata and do not enter model context. Use `/shell-leash` to inspect request grants and observations.

The `pi-snapshot` command can list, inspect, verify, export, and restore snapshots. It can compare a snapshot with the live project or with another snapshot. Its list reports the sum of per-entry bytes APFS says would be freed immediately. Restore starts as a dry run. Use `--apply` when you want it to change files.

Projects can list extra secret paths in `.pi/pi-safety.json`:

```json
{
  "version": 1,
  "protectedPaths": ["secrets/**", "config/private.json"]
}
```

Use `/pi-safety` in Pi to see whether the extension is ready and whether the current request has a snapshot.

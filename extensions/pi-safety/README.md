# Pi Safety

Pi Safety is a macOS extension that makes Pi safer to use on local projects.

Pi itself runs normally. Each Bash command runs in a new macOS sandbox. Bash can change files in the current project, but it cannot change files elsewhere unless a supported tool needs a specific location.

Pi's built-in `read`, `write`, and `edit` tools still work normally. Pi Safety checks their file paths before they run. It blocks access to secrets such as `.env` files, private SSH keys, cloud credentials, and Pi authentication data. It also prevents changes to Git hooks, shell startup files, and other sensitive settings.

The defaults are defined in `default-rules.ts` with simple `noAccess`, `readOnly`, `readWrite`, and snapshot-exclusion rules. Built-in tools, Bash, movement protection, snapshots, and diagnostics all use those same rules.

Before the first command that can change files in a request, Pi Safety creates a fast APFS snapshot of the project. It creates only one snapshot per request and keeps up to 20 snapshots for each project. Generated folders such as `.git`, `.wb`, `node_modules`, `dist`, and `target` are not included.

The `pi-snapshot` command can list, inspect, compare, verify, export, and restore snapshots. Restore starts as a dry run. Use `--apply` when you want it to change files.

Projects can list extra secret paths in `.pi/pi-safety.json`:

```json
{
  "version": 1,
  "protectedPaths": ["secrets/**", "config/private.json"]
}
```

Use `/pi-safety` in Pi to see whether the extension is ready and whether the current request has a snapshot.

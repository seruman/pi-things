# Shell Leash

Shell Leash is the remote-effect guard used by Pi Safety.

It analyzes model-issued Bash before execution. The first release guards Git pushes and GitHub mutations. Known mutations require approval. Approval can cover one Bash call or a scoped operation for the current request.

The static Bash analyzer and the runtime `git` and `gh` shims use the same TypeScript effect analyzers. A shim never asks for late approval. It rejects an ungranted mutation and explains how to rerun it for approval.

Unknown syntax and dynamic commands are stored as hidden Pi session entries. They do not enter model context. Use `/shell-leash observations` to inspect them. Use `/shell-leash export-observations <absolute-new-file>` to export them as private JSON. Use `/shell-leash clear-grants` to revoke request leases. Use `/shell-leash policy` to inspect every guarded operation ID.

A request lease can be limited to a Git remote or GitHub repository. The approval menu also offers an explicit any-target lease. Push, force-push, and deletion operations remain separate.

The user's `!` commands, external terminals, and normal PATH are unchanged.

import type { CanonicalPath } from "./canonical-path"
import type { RestorePlan, RestoreScope } from "./restore"
import type { RelativeSnapshotPath } from "./snapshot"
import type { LoadedSnapshot } from "./snapshot-history"

declare const canonicalPath: CanonicalPath

declare const snapshot: LoadedSnapshot

declare const relativePath: RelativeSnapshotPath

// @ts-expect-error Selected scopes must come from selectedRestoreScope, even with validated paths.
const forgedScope: RestoreScope = { kind: "selected", paths: [relativePath] }

// @ts-expect-error Restore plans must come from planRestore.
const forgedPlan: RestorePlan = {
	workspaceRoot: canonicalPath,
	snapshot,
	scope: { kind: "all" },
	actions: [],
}

void forgedScope

void forgedPlan

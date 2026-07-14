import type { CanonicalPath } from "./canonical-path"
import type { RestorePlan, RestoreScope } from "./restore"
import type { LoadedSnapshot } from "./snapshot-history"

declare const canonicalPath: CanonicalPath
declare const snapshot: LoadedSnapshot

// @ts-expect-error Selected scopes must come from selectedRestoreScope.
const forgedScope: RestoreScope = { kind: "selected", paths: ["../escape"] }

// @ts-expect-error Restore plans must come from planRestore.
const forgedPlan: RestorePlan = {
	workspaceRoot: canonicalPath,
	snapshot,
	scope: { kind: "all" },
	actions: [],
}

void forgedScope
void forgedPlan

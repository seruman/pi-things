import type { CanonicalPath } from "./canonical-path"
import type { Policy } from "./policy"
import type {
	PublishedSnapshotRef,
	RelativeSnapshotPath,
	SnapshotFileStorage,
	SnapshotId,
	SnapshotPlan,
	SnapshotStore,
} from "./snapshot"

declare const canonicalPath: CanonicalPath
declare const snapshotId: SnapshotId
declare const policy: Policy

// @ts-expect-error Snapshot plans can only be produced by planSnapshot.
const forgedPlan: SnapshotPlan = { workspaceRoot: canonicalPath, entries: [] }

// @ts-expect-error Published references can only be produced by publishSnapshot.
const forgedPublished: PublishedSnapshotRef = {
	id: snapshotId,
	directory: canonicalPath,
	createdAt: "2026-01-01T00:00:00.000Z",
}

// @ts-expect-error Snapshot stores require successful parsing and containment checks.
const forgedStore: SnapshotStore = {
	workspaceRoot: canonicalPath,
	projectDirectory: canonicalPath,
	policy,
	maxSnapshots: 20,
}

// @ts-expect-error Relative snapshot paths cannot be supplied as unchecked strings.
const forgedRelativePath: RelativeSnapshotPath = "../escape"

// @ts-expect-error Storage is a closed union, not independently combinable booleans.
const invalidStorage: SnapshotFileStorage = { kind: "ordinary", protected: true }

void forgedPlan
void forgedPublished
void forgedStore
void forgedRelativePath
void invalidStorage

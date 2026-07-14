import {
	type BuiltinPolicyError,
	type InitialBuiltinConfiguration,
	type RawInitialBuiltinAccessPolicy,
	parseInitialBuiltinConfiguration,
} from "./builtin-policy"
import { type CanonicalPath, parseCanonicalPath } from "./canonical-path"
import { type Result, err, ok } from "./result"
import { type SnapshotError, type SnapshotStore, createSnapshotStore } from "./snapshot"

export interface SafetyFilesystem {
	readonly snapshotStore: SnapshotStore
}

export type SafetyFilesystemError =
	| { readonly kind: "builtin-policy"; readonly cause: BuiltinPolicyError }
	| { readonly kind: "snapshot-root"; readonly field: "cwd" | "stateHome"; readonly path: string }
	| { readonly kind: "snapshot-store"; readonly cause: SnapshotError }

export function createSafetyFilesystem(
	raw: RawInitialBuiltinAccessPolicy,
): Result<SafetyFilesystem, SafetyFilesystemError> {
	const configuration = parseInitialBuiltinConfiguration(raw)
	if (!configuration.ok) return err({ kind: "builtin-policy", cause: configuration.error })
	const snapshotStore = createConfiguredSnapshotStore(configuration.value)
	if (!snapshotStore.ok) return err({ kind: "snapshot-store", cause: snapshotStore.error })
	return ok(Object.freeze({ snapshotStore: snapshotStore.value }))
}

export function createSandboxedSafetyFilesystem(raw: {
	readonly cwd: string
	readonly stateHome: string
}): Result<SafetyFilesystem, SafetyFilesystemError> {
	const workspaceRoot = parseSnapshotRoot("cwd", raw.cwd)
	if (!workspaceRoot.ok) return workspaceRoot
	const stateHome = parseSnapshotRoot("stateHome", raw.stateHome)
	if (!stateHome.ok) return stateHome
	const snapshotStore = createSnapshotStore({
		workspaceRoot: workspaceRoot.value,
		stateRoot: stateHome.value,
		protection: { patterns: [], protectedRoots: [] },
	})
	if (!snapshotStore.ok) return err({ kind: "snapshot-store", cause: snapshotStore.error })
	return ok(Object.freeze({ snapshotStore: snapshotStore.value }))
}

function parseSnapshotRoot(field: "cwd" | "stateHome", pathname: string): Result<CanonicalPath, SafetyFilesystemError> {
	const parsed = parseCanonicalPath(pathname)
	return parsed.ok ? parsed : err({ kind: "snapshot-root", field, path: pathname })
}

export function createConfiguredSnapshotStore(
	configuration: InitialBuiltinConfiguration,
): Result<SnapshotStore, SnapshotError> {
	const policy = configuration.accessPolicy
	return createSnapshotStore({
		workspaceRoot: policy.workspaceRoot,
		stateRoot: configuration.stateHome,
		protection: {
			patterns: policy.secretPatterns,
			protectedRoots: [
				{
					root: policy.ssh.protectedRoot,
					ordinaryExceptions: policy.ssh.readableMetadata,
				},
			],
		},
	})
}

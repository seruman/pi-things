import { type CanonicalPath, parseCanonicalPath } from "./canonical-path"
import { type DefaultRulesError, createSnapshotFilePolicy } from "./default-rules"
import {
	type FilePolicyConfigurationError,
	type InitialSafetyConfiguration,
	type RawInitialFilePolicy,
	parseInitialSafetyConfiguration,
} from "./policy-configuration"
import { type Result, err } from "./result"
import { type SnapshotError, type SnapshotStore, createSnapshotStore } from "./snapshot"

export type SafetyFilesystemError =
	| { readonly kind: "file-policy-configuration"; readonly cause: FilePolicyConfigurationError }
	| { readonly kind: "snapshot-root"; readonly field: "cwd" | "stateHome"; readonly path: string }
	| { readonly kind: "file-policy"; readonly cause: DefaultRulesError }
	| { readonly kind: "snapshot-store"; readonly cause: SnapshotError }

export function createSafetyFilesystem(raw: RawInitialFilePolicy): Result<SnapshotStore, SafetyFilesystemError> {
	const configuration = parseInitialSafetyConfiguration(raw)
	if (!configuration.ok) return err({ kind: "file-policy-configuration", cause: configuration.error })
	const snapshotStore = createConfiguredSnapshotStore(configuration.value)
	return snapshotStore.ok ? snapshotStore : err({ kind: "snapshot-store", cause: snapshotStore.error })
}

export function createSandboxedSafetyFilesystem(raw: {
	readonly cwd: string
	readonly stateHome: string
}): Result<SnapshotStore, SafetyFilesystemError> {
	const workspaceRoot = parseSnapshotRoot("cwd", raw.cwd)
	if (!workspaceRoot.ok) return workspaceRoot
	const stateHome = parseSnapshotRoot("stateHome", raw.stateHome)
	if (!stateHome.ok) return stateHome
	const filePolicy = createSnapshotFilePolicy(workspaceRoot.value)
	if (!filePolicy.ok) return err({ kind: "file-policy", cause: filePolicy.error })
	const snapshotStore = createSnapshotStore({
		workspaceRoot: workspaceRoot.value,
		stateRoot: stateHome.value,
		filePolicy: filePolicy.value,
	})
	return snapshotStore.ok ? snapshotStore : err({ kind: "snapshot-store", cause: snapshotStore.error })
}

function parseSnapshotRoot(field: "cwd" | "stateHome", pathname: string): Result<CanonicalPath, SafetyFilesystemError> {
	const parsed = parseCanonicalPath(pathname)
	return parsed.ok ? parsed : err({ kind: "snapshot-root", field, path: pathname })
}

export function createConfiguredSnapshotStore(
	configuration: InitialSafetyConfiguration,
): Result<SnapshotStore, SnapshotError> {
	return createSnapshotStore({
		workspaceRoot: configuration.filePolicy.workspaceRoot,
		stateRoot: configuration.stateHome,
		filePolicy: configuration.filePolicy,
	})
}

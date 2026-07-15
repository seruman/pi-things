import { type CanonicalPath, parseCanonicalPath } from "./canonical-path"
import { type DefaultPolicyError, createDefaultPolicy, createSnapshotPolicy } from "./default-policy"
import type { Policy } from "./policy"
import {
	type InitialSafetyConfiguration,
	type PolicyConfigurationError,
	type RawPolicyConfiguration,
	parseInitialSafetyConfiguration,
} from "./policy-configuration"
import { type Result, err } from "./result"
import { type SnapshotError, type SnapshotStore, createSnapshotStore } from "./snapshot"

export type SafetyFilesystemError =
	| { readonly kind: "policy-configuration"; readonly cause: PolicyConfigurationError }
	| { readonly kind: "snapshot-root"; readonly field: "cwd" | "stateHome"; readonly path: string }
	| { readonly kind: "policy"; readonly cause: DefaultPolicyError }
	| { readonly kind: "snapshot-store"; readonly cause: SnapshotError }

export function createSafetyFilesystem(raw: RawPolicyConfiguration): Result<SnapshotStore, SafetyFilesystemError> {
	const configuration = parseInitialSafetyConfiguration(raw)
	if (!configuration.ok) return err({ kind: "policy-configuration", cause: configuration.error })
	const policy = createDefaultPolicy({
		paths: configuration.value.paths,
		additionalNoAccessPatterns: configuration.value.additionalNoAccessPatterns,
		sandbox: { kind: "disabled" },
	})
	if (!policy.ok) return err({ kind: "policy", cause: policy.error })
	const snapshotStore = createConfiguredSnapshotStore(configuration.value, policy.value)
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
	const policy = createSnapshotPolicy(workspaceRoot.value)
	if (!policy.ok) return err({ kind: "policy", cause: policy.error })
	const snapshotStore = createSnapshotStore({
		workspaceRoot: workspaceRoot.value,
		stateRoot: stateHome.value,
		policy: policy.value,
	})
	return snapshotStore.ok ? snapshotStore : err({ kind: "snapshot-store", cause: snapshotStore.error })
}

function parseSnapshotRoot(field: "cwd" | "stateHome", pathname: string): Result<CanonicalPath, SafetyFilesystemError> {
	const parsed = parseCanonicalPath(pathname)
	return parsed.ok ? parsed : err({ kind: "snapshot-root", field, path: pathname })
}

export function createConfiguredSnapshotStore(
	configuration: InitialSafetyConfiguration,
	policy: Policy,
): Result<SnapshotStore, SnapshotError> {
	return createSnapshotStore({
		workspaceRoot: configuration.paths.workspace,
		stateRoot: configuration.paths.stateHome,
		policy,
	})
}

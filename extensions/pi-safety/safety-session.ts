import { compileBashProfile } from "./bash-profile"
import {
	type BuiltinPolicyError,
	type RawInitialBuiltinAccessPolicy,
	parseInitialBuiltinConfiguration,
} from "./builtin-policy"
import { type CanonicalPath, parseCanonicalPath } from "./canonical-path"
import { type CheckpointError, type CheckpointRun, type CheckpointStatus, createCheckpointRun } from "./checkpoint"
import {
	type BashIntegrations,
	type IntegrationError,
	type RawIntegrationEnvironment,
	cleanupBashIntegrations,
	parseBashIntegrations,
	prepareBashIntegrations,
} from "./integrations"
import { type Result, err, ok } from "./result"
import { createConfiguredSnapshotStore } from "./safety-filesystem"
import type { CompiledSbpl } from "./sbpl"
import { type SnapshotError, type SnapshotStore, createSnapshot } from "./snapshot"
import {
	type BuiltinAccessPolicy,
	type GuardedToolCall,
	type ToolAuthorizationError,
	authorizeBuiltinToolCall,
} from "./tool-authorization"

export interface RawSafetySessionConfiguration extends RawInitialBuiltinAccessPolicy {
	readonly privateTemp: string
	readonly integrationEnvironment: RawIntegrationEnvironment
}

export type SafetySessionError =
	| { readonly kind: "builtin-policy"; readonly cause: BuiltinPolicyError }
	| { readonly kind: "private-temp"; readonly message: string }
	| { readonly kind: "integration"; readonly cause: IntegrationError }
	| { readonly kind: "snapshot-store"; readonly cause: SnapshotError }

export type SafetyDecisionCause =
	| { readonly kind: "authorization"; readonly cause: ToolAuthorizationError }
	| { readonly kind: "run-not-started" }
	| { readonly kind: "checkpoint"; readonly cause: CheckpointError }

export type SafetyDecision =
	| { readonly kind: "allow"; readonly authorization: GuardedToolCall }
	| { readonly kind: "block"; readonly reason: string; readonly cause: SafetyDecisionCause }

export type SafetySessionCheckpointStatus = CheckpointStatus | { readonly kind: "run-not-started" }

export interface SafetySession {
	readonly snapshotStore: SnapshotStore
	beginAgentRun(): Result<undefined, { readonly kind: "checkpoint-creation-in-progress" }>
	checkpointStatus(): SafetySessionCheckpointStatus
	compileBashProfile(): CompiledSbpl
	bashEnvironment(): Readonly<NodeJS.ProcessEnv>
	cleanup(): Result<undefined, IntegrationError>
	authorize(toolName: string, input: unknown): Promise<SafetyDecision>
}

class ManagedSafetySession implements SafetySession {
	readonly snapshotStore: SnapshotStore
	readonly #policy: BuiltinAccessPolicy
	readonly #privateTemp: CanonicalPath
	readonly #integrations: BashIntegrations
	#checkpointRun: CheckpointRun | undefined

	constructor(
		policy: BuiltinAccessPolicy,
		privateTemp: CanonicalPath,
		integrations: BashIntegrations,
		snapshotStore: SnapshotStore,
	) {
		this.#policy = policy
		this.#privateTemp = privateTemp
		this.#integrations = integrations
		this.snapshotStore = snapshotStore
	}

	beginAgentRun(): Result<undefined, { readonly kind: "checkpoint-creation-in-progress" }> {
		if (this.#checkpointRun?.status().kind === "creating") {
			return err({ kind: "checkpoint-creation-in-progress" })
		}
		this.#checkpointRun = createCheckpointRun(async () => createSnapshot(this.snapshotStore))
		return ok(undefined)
	}

	checkpointStatus(): SafetySessionCheckpointStatus {
		return this.#checkpointRun?.status() ?? { kind: "run-not-started" }
	}

	compileBashProfile(): CompiledSbpl {
		return compileBashProfile({
			policy: this.#policy,
			privateTemp: this.#privateTemp,
			integrations: this.#integrations,
		})
	}

	bashEnvironment(): Readonly<NodeJS.ProcessEnv> {
		return this.#integrations.wb.kind === "enabled"
			? { WB_SOCKET: this.#integrations.wb.socket, WB_LOG: this.#integrations.wb.log }
			: {}
	}

	cleanup(): Result<undefined, IntegrationError> {
		return cleanupBashIntegrations(this.#integrations)
	}

	async authorize(toolName: string, input: unknown): Promise<SafetyDecision> {
		const authorization = authorizeBuiltinToolCall(toolName, input, this.#policy)
		if (!authorization.ok) {
			const cause = { kind: "authorization", cause: authorization.error } as const
			return { kind: "block", reason: formatAuthorizationError(authorization.error), cause }
		}
		if (authorization.value.kind === "read" || authorization.value.kind === "other") {
			return { kind: "allow", authorization: authorization.value }
		}
		if (!this.#checkpointRun) {
			return {
				kind: "block",
				reason: "pi-safety: checkpoint run has not started",
				cause: { kind: "run-not-started" },
			}
		}
		const checkpoint = await this.#checkpointRun.ensureCheckpoint()
		if (!checkpoint.ok) {
			return {
				kind: "block",
				reason: `pi-safety: checkpoint failed (${formatCheckpointError(checkpoint.error)})`,
				cause: { kind: "checkpoint", cause: checkpoint.error },
			}
		}
		return { kind: "allow", authorization: authorization.value }
	}
}

export function createSafetySession(raw: RawSafetySessionConfiguration): Result<SafetySession, SafetySessionError> {
	const configuration = parseInitialBuiltinConfiguration(raw)
	if (!configuration.ok) return err({ kind: "builtin-policy", cause: configuration.error })
	const privateTemp = parseCanonicalPath(raw.privateTemp)
	if (!privateTemp.ok) return err({ kind: "private-temp", message: JSON.stringify(privateTemp.error) })
	const integrations = parseBashIntegrations({
		environment: raw.integrationEnvironment,
		home: configuration.value.accessPolicy.homeRoot,
	})
	if (!integrations.ok) return err({ kind: "integration", cause: integrations.error })
	const preparedIntegrations = prepareBashIntegrations(integrations.value)
	if (!preparedIntegrations.ok) return err({ kind: "integration", cause: preparedIntegrations.error })
	const snapshotStore = createConfiguredSnapshotStore(configuration.value)
	if (!snapshotStore.ok) {
		const cleaned = cleanupBashIntegrations(integrations.value)
		return cleaned.ok
			? err({ kind: "snapshot-store", cause: snapshotStore.error })
			: err({ kind: "integration", cause: cleaned.error })
	}
	return ok(
		new ManagedSafetySession(
			configuration.value.accessPolicy,
			privateTemp.value,
			integrations.value,
			snapshotStore.value,
		),
	)
}

function formatAuthorizationError(error: ToolAuthorizationError): string {
	switch (error.kind) {
		case "invalid-tool-input":
			return `pi-safety: blocked ${error.tool}: ${error.reason}`
		case "path-resolution":
			return `pi-safety: blocked ${error.tool}: path resolution failed (${error.cause.kind})`
		case "secret-path":
			return `pi-safety: blocked ${error.tool} of protected secret ${error.path}`
		case "protected-snapshot-path":
			return `pi-safety: blocked ${error.tool} of protected snapshot content ${error.path}`
		case "protected-write-path":
			return `pi-safety: blocked ${error.tool} to protected configuration ${error.path}`
		case "immutable-write-root":
			return `pi-safety: blocked ${error.tool} to immutable state ${error.path}`
		case "outside-workspace":
			return `pi-safety: blocked ${error.tool} outside workspace ${error.workspaceRoot}: ${error.path}`
	}
}

function formatCheckpointError(error: CheckpointError): string {
	switch (error.kind) {
		case "creator-rejected":
			return error.message
		case "snapshot-failed":
			return formatSnapshotError(error.cause)
	}
}

function formatSnapshotError(error: SnapshotError): string {
	switch (error.kind) {
		case "invalid-store":
		case "clone-unsupported":
			return `${error.kind}: ${error.message}`
		case "path-resolution":
			return `${error.kind} at ${error.path}: ${error.message}`
		case "unsupported-entry":
			return `${error.kind} at ${error.path}: ${error.entryType}`
		case "filesystem-race":
			return `${error.kind} at ${error.path}: expected ${error.expected}`
		case "project-locked":
			return `${error.kind} at ${error.path}`
		case "retention-conflict":
			return `${error.kind}: cannot retain required snapshots within limit ${error.maxSnapshots}`
		case "io":
			return `${error.kind} during ${error.operation} at ${error.path}: ${error.message}`
	}
}

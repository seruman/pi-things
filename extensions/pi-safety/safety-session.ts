import { parseCanonicalPath } from "./canonical-path"
import { type CheckpointError, CheckpointRun, type CheckpointStatus } from "./checkpoint"
import { type DefaultPolicyError, createDefaultPolicy } from "./default-policy"
import {
	type BashIntegrations,
	type IntegrationError,
	type RawIntegrationEnvironment,
	cleanupBashIntegrations,
	parseBashIntegrations,
	prepareBashIntegrations,
} from "./integrations"
import type { Policy } from "./policy"
import {
	type PolicyConfigurationError,
	type RawPolicyConfiguration,
	parseInitialSafetyConfiguration,
} from "./policy-configuration"
import { describePolicy } from "./policy-description"
import { type Result, err, ok } from "./result"
import { createConfiguredSnapshotStore } from "./safety-filesystem"
import type { CompiledSbpl } from "./sbpl"
import { emitSeatbelt } from "./seatbelt"
import { type SnapshotCreationOrigin, type SnapshotError, type SnapshotStore, createSnapshot } from "./snapshot"
import { type ToolAuthorizationError, authorizeBuiltinToolCall } from "./tool-authorization"

export interface RawSafetySessionConfiguration extends RawPolicyConfiguration {
	readonly privateTemp: string
	readonly integrationEnvironment: RawIntegrationEnvironment
}

export type SafetySessionError =
	| { readonly kind: "policy-configuration"; readonly cause: PolicyConfigurationError }
	| { readonly kind: "policy"; readonly cause: DefaultPolicyError }
	| { readonly kind: "private-temp"; readonly message: string }
	| { readonly kind: "integration"; readonly cause: IntegrationError }
	| { readonly kind: "snapshot-store"; readonly cause: SnapshotError }

export type SafetyDecision = { readonly kind: "allow" } | { readonly kind: "block"; readonly reason: string }

export type SafetySessionCheckpointStatus = CheckpointStatus | { readonly kind: "run-not-started" }

export interface SafetySession {
	readonly snapshotStore: SnapshotStore
	beginAgentRun(
		origin?: SnapshotCreationOrigin,
	): Result<undefined, { readonly kind: "checkpoint-creation-in-progress" }>
	checkpointStatus(): SafetySessionCheckpointStatus
	seatbeltProfile(): CompiledSbpl
	policyDescription(): string
	bashEnvironment(): Readonly<NodeJS.ProcessEnv>
	cleanup(): Result<undefined, IntegrationError>
	authorize(toolName: string, input: unknown): Promise<SafetyDecision>
}

class ManagedSafetySession implements SafetySession {
	readonly snapshotStore: SnapshotStore
	readonly #policy: Policy
	readonly #integrations: BashIntegrations
	#checkpointRun: CheckpointRun | undefined

	constructor(policy: Policy, integrations: BashIntegrations, snapshotStore: SnapshotStore) {
		this.#policy = policy
		this.#integrations = integrations
		this.snapshotStore = snapshotStore
	}

	beginAgentRun(
		origin: SnapshotCreationOrigin = { kind: "standalone" },
	): Result<undefined, { readonly kind: "checkpoint-creation-in-progress" }> {
		if (this.#checkpointRun?.status().kind === "creating") {
			return err({ kind: "checkpoint-creation-in-progress" })
		}
		this.#checkpointRun = new CheckpointRun(async () => createSnapshot(this.snapshotStore, { origin }))
		return ok(undefined)
	}

	checkpointStatus(): SafetySessionCheckpointStatus {
		return this.#checkpointRun?.status() ?? { kind: "run-not-started" }
	}

	seatbeltProfile(): CompiledSbpl {
		return emitSeatbelt(this.#policy)
	}

	policyDescription(): string {
		return describePolicy(this.#policy)
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
			return { kind: "block", reason: formatAuthorizationError(authorization.error) }
		}
		if (authorization.value.kind === "read" || authorization.value.kind === "other") return { kind: "allow" }
		if (!this.#checkpointRun) {
			return { kind: "block", reason: "pi-safety: checkpoint run has not started" }
		}
		const checkpoint = await this.#checkpointRun.ensureCheckpoint()
		if (!checkpoint.ok) {
			return {
				kind: "block",
				reason: `pi-safety: checkpoint failed (${formatCheckpointError(checkpoint.error)})`,
			}
		}
		return { kind: "allow" }
	}
}

export function createSafetySession(raw: RawSafetySessionConfiguration): Result<SafetySession, SafetySessionError> {
	const configuration = parseInitialSafetyConfiguration(raw)
	if (!configuration.ok) return err({ kind: "policy-configuration", cause: configuration.error })
	const privateTemp = parseCanonicalPath(raw.privateTemp)
	if (!privateTemp.ok) return err({ kind: "private-temp", message: JSON.stringify(privateTemp.error) })
	const integrations = parseBashIntegrations({
		environment: raw.integrationEnvironment,
		home: configuration.value.paths.home,
	})
	if (!integrations.ok) return err({ kind: "integration", cause: integrations.error })
	const preparedIntegrations = prepareBashIntegrations(integrations.value)
	if (!preparedIntegrations.ok) return err({ kind: "integration", cause: preparedIntegrations.error })
	const policy = createDefaultPolicy({
		paths: configuration.value.paths,
		additionalNoAccessPatterns: configuration.value.additionalNoAccessPatterns,
		sandbox: { kind: "enabled", privateTemp: privateTemp.value, integrations: integrations.value },
	})
	if (!policy.ok) return cleanupAfterFailure(integrations.value, { kind: "policy", cause: policy.error })
	const snapshotStore = createConfiguredSnapshotStore(configuration.value, policy.value)
	if (!snapshotStore.ok) {
		return cleanupAfterFailure(integrations.value, { kind: "snapshot-store", cause: snapshotStore.error })
	}
	return ok(new ManagedSafetySession(policy.value, integrations.value, snapshotStore.value))
}

function cleanupAfterFailure(
	integrations: BashIntegrations,
	error: Extract<SafetySessionError, { readonly kind: "policy" | "snapshot-store" }>,
): Result<never, SafetySessionError> {
	const cleaned = cleanupBashIntegrations(integrations)
	return cleaned.ok ? err(error) : err({ kind: "integration", cause: cleaned.error })
}

function formatAuthorizationError(error: ToolAuthorizationError): string {
	switch (error.kind) {
		case "invalid-tool-input":
			return `pi-safety: blocked ${error.tool}: ${error.reason}`
		case "path-resolution":
			return `pi-safety: blocked ${error.tool}: path resolution failed (${error.cause.kind})`
		case "access-denied":
			return `pi-safety: blocked ${error.tool}: ${error.required} access denied to ${error.path}`
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

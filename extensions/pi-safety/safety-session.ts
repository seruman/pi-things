import * as path from "node:path"
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent"
import { type CanonicalPath, parseCanonicalPath } from "./canonical-path"
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
import { type PolicyDisplayEntry, describePolicy, describeSeatbeltPolicy } from "./policy-description"
import { type Result, err, ok } from "./result"
import type { CompiledSbpl } from "./sbpl"
import { emitSeatbelt } from "./seatbelt"
import {
	type SessionPathAccess,
	type SessionPathError,
	type SessionPathGrant,
	parseSessionPathGrant,
	parseSessionPathsEnvironment,
} from "./session-paths"
import { type ToolAuthorizationError, authorizeBuiltinToolCall } from "./tool-authorization"

export interface RawSafetySessionConfiguration extends RawPolicyConfiguration {
	readonly gopath?: string
	readonly privateTemp: string
	readonly integrationEnvironment: RawIntegrationEnvironment
	readonly sessionPathsEnvironment?: string
}

export type SafetySessionError =
	| { readonly kind: "policy-configuration"; readonly cause: PolicyConfigurationError }
	| { readonly kind: "policy"; readonly cause: DefaultPolicyError }
	| { readonly kind: "private-temp"; readonly message: string }
	| { readonly kind: "go-path"; readonly path: string; readonly message: string }
	| { readonly kind: "session-path"; readonly cause: SessionPathError }
	| { readonly kind: "integration"; readonly cause: IntegrationError }

export type SafetyDecision = { readonly kind: "allow" } | { readonly kind: "block"; readonly reason: string }

export interface SafetySession {
	seatbeltProfile(): CompiledSbpl
	policyDescription(): string
	seatbeltPolicy(): readonly PolicyDisplayEntry[]
	bashEnvironment(): Readonly<NodeJS.ProcessEnv>
	cleanup(): Result<undefined, IntegrationError>
	sessionPaths(): readonly SessionPathGrant[]
	addSessionPath(
		path: string,
		access: SessionPathAccess,
	): Result<SessionPathGrant, SessionPathError | DefaultPolicyError>
	removeSessionPath(path: string): Result<boolean, SessionPathError | DefaultPolicyError>
	guard(toolName: string, input: ToolCallEvent["input"]): SafetyDecision
}

class ManagedSafetySession implements SafetySession {
	#policy: Policy
	readonly #integrations: BashIntegrations
	readonly #policyInput: Omit<Parameters<typeof createDefaultPolicy>[0], "sessionPaths">
	#sessionPaths: readonly SessionPathGrant[]

	constructor(
		policy: Policy,
		integrations: BashIntegrations,
		policyInput: Omit<Parameters<typeof createDefaultPolicy>[0], "sessionPaths">,
		sessionPaths: readonly SessionPathGrant[],
	) {
		this.#policy = policy
		this.#integrations = integrations
		this.#policyInput = policyInput
		this.#sessionPaths = sessionPaths
	}

	seatbeltProfile(): CompiledSbpl {
		return emitSeatbelt(this.#policy)
	}

	policyDescription(): string {
		return describePolicy(this.#policy)
	}

	seatbeltPolicy(): readonly PolicyDisplayEntry[] {
		return describeSeatbeltPolicy(this.#policy)
	}

	bashEnvironment(): Readonly<NodeJS.ProcessEnv> {
		return this.#integrations.wb.kind === "enabled"
			? { WB_SOCKET: this.#integrations.wb.socket, WB_LOG: this.#integrations.wb.log }
			: {}
	}

	cleanup(): Result<undefined, IntegrationError> {
		return cleanupBashIntegrations(this.#integrations)
	}

	sessionPaths(): readonly SessionPathGrant[] {
		return [...this.#sessionPaths]
	}

	addSessionPath(
		pathname: string,
		access: SessionPathAccess,
	): Result<SessionPathGrant, SessionPathError | DefaultPolicyError> {
		const parsed = parseSessionPathGrant({
			path: pathname,
			access,
			home: this.#policyInput.paths.home,
			allowTilde: true,
		})

		if (!parsed.ok) return parsed
		const next = [...this.#sessionPaths.filter((grant) => grant.path !== parsed.value.path), parsed.value]
		const updated = createDefaultPolicy({ ...this.#policyInput, sessionPaths: next })

		if (!updated.ok) return updated
		this.#sessionPaths = Object.freeze(next)
		this.#policy = updated.value

		return parsed
	}

	removeSessionPath(pathname: string): Result<boolean, SessionPathError | DefaultPolicyError> {
		const existing = this.#sessionPaths.find((grant) => grant.path === pathname)

		const parsed = existing
			? ok(existing)
			: parseSessionPathGrant({
					path: pathname,
					access: "read-only",
					home: this.#policyInput.paths.home,
					allowTilde: true,
				})

		if (!parsed.ok) return parsed
		const next = this.#sessionPaths.filter((grant) => grant.path !== parsed.value.path)

		if (next.length === this.#sessionPaths.length) return ok(false)
		const updated = createDefaultPolicy({ ...this.#policyInput, sessionPaths: next })

		if (!updated.ok) return updated
		this.#sessionPaths = Object.freeze(next)
		this.#policy = updated.value

		return ok(true)
	}

	guard(toolName: string, input: ToolCallEvent["input"]): SafetyDecision {
		const authorization = authorizeBuiltinToolCall(toolName, input, this.#policy)

		return authorization.ok
			? { kind: "allow" }
			: { kind: "block", reason: formatAuthorizationError(authorization.error) }
	}
}

export function createSafetySession(raw: RawSafetySessionConfiguration): Result<SafetySession, SafetySessionError> {
	const configuration = parseInitialSafetyConfiguration(raw)

	if (!configuration.ok) return err({ kind: "policy-configuration", cause: configuration.error })
	const privateTemp = parseCanonicalPath(raw.privateTemp)

	if (!privateTemp.ok) return err({ kind: "private-temp", message: JSON.stringify(privateTemp.error) })
	const goPaths = parseGoPaths(raw.gopath, configuration.value.paths.home)

	if (!goPaths.ok) return goPaths
	const sessionPaths = parseSessionPathsEnvironment(raw.sessionPathsEnvironment, configuration.value.paths.home)

	if (!sessionPaths.ok) return err({ kind: "session-path", cause: sessionPaths.error })

	const integrations = parseBashIntegrations({
		environment: raw.integrationEnvironment,
		home: configuration.value.paths.home,
	})

	if (!integrations.ok) return err({ kind: "integration", cause: integrations.error })
	const preparedIntegrations = prepareBashIntegrations(integrations.value)

	if (!preparedIntegrations.ok) return err({ kind: "integration", cause: preparedIntegrations.error })

	const policyInput = {
		paths: configuration.value.paths,
		additionalNoAccessPatterns: configuration.value.additionalNoAccessPatterns,
		goPaths: goPaths.value,
		sandbox: { kind: "enabled" as const, privateTemp: privateTemp.value, integrations: integrations.value },
	}

	const policy = createDefaultPolicy({ ...policyInput, sessionPaths: sessionPaths.value })

	if (!policy.ok) return cleanupAfterFailure(integrations.value, { kind: "policy", cause: policy.error })

	return ok(new ManagedSafetySession(policy.value, integrations.value, policyInput, sessionPaths.value))
}

function parseGoPaths(
	input: string | undefined,
	home: CanonicalPath,
): Result<readonly CanonicalPath[], SafetySessionError> {
	const values = input === undefined || input.length === 0 ? [path.join(home, "go")] : input.split(path.delimiter)
	const parsed: CanonicalPath[] = []

	for (const value of values) {
		const goPath = parseCanonicalPath(value)

		if (!goPath.ok) return err({ kind: "go-path", path: value, message: JSON.stringify(goPath.error) })
		parsed.push(goPath.value)
	}

	return ok(Object.freeze(parsed))
}

function cleanupAfterFailure(
	integrations: BashIntegrations,
	error: Extract<SafetySessionError, { readonly kind: "policy" }>,
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

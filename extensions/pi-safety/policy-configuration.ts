import { type CanonicalPath, type CanonicalPathError, parseCanonicalPath } from "./canonical-path"
import type { DefaultPolicyPaths } from "./default-policy"
import { type Result, err, ok } from "./result"

export interface RawPolicyConfiguration {
	readonly cwd: string
	readonly home: string
	readonly stateHome: string
	readonly piConfigDir: string
	readonly additionalNoAccessPatterns: readonly string[]
}

export type PolicyConfigurationError = {
	readonly kind: "canonical-path"
	readonly field: "cwd" | "home" | "stateHome" | "piConfigDir"
	readonly cause: CanonicalPathError
}

export interface InitialSafetyConfiguration {
	readonly paths: DefaultPolicyPaths
	readonly additionalNoAccessPatterns: readonly string[]
}

export function parseInitialSafetyConfiguration(
	raw: RawPolicyConfiguration,
): Result<InitialSafetyConfiguration, PolicyConfigurationError> {
	const workspace = parsePolicyPath("cwd", raw.cwd)
	if (!workspace.ok) return workspace
	const home = parsePolicyPath("home", raw.home)
	if (!home.ok) return home
	const stateHome = parsePolicyPath("stateHome", raw.stateHome)
	if (!stateHome.ok) return stateHome
	const piConfigDirectory = parsePolicyPath("piConfigDir", raw.piConfigDir)
	if (!piConfigDirectory.ok) return piConfigDirectory
	return ok(
		Object.freeze({
			paths: Object.freeze({
				workspace: workspace.value,
				home: home.value,
				stateHome: stateHome.value,
				piConfigDirectory: piConfigDirectory.value,
			}),
			additionalNoAccessPatterns: Object.freeze([...raw.additionalNoAccessPatterns]),
		}),
	)
}

function parsePolicyPath(
	field: PolicyConfigurationError["field"],
	input: string,
): Result<CanonicalPath, PolicyConfigurationError> {
	const parsed = parseCanonicalPath(input)
	return parsed.ok ? parsed : err({ kind: "canonical-path", field, cause: parsed.error })
}

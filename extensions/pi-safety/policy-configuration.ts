import { type CanonicalPath, type CanonicalPathError, parseCanonicalPath } from "./canonical-path"
import { type DefaultRulePaths, type DefaultRulesError, createDefaultFilePolicy } from "./default-rules"
import type { FilePolicy } from "./file-policy"
import { type Result, err, ok } from "./result"

export interface RawInitialFilePolicy {
	readonly cwd: string
	readonly home: string
	readonly stateHome: string
	readonly piConfigDir: string
	readonly additionalNoAccessPatterns: readonly string[]
}

export type FilePolicyConfigurationError =
	| {
			readonly kind: "canonical-path"
			readonly field: "cwd" | "home" | "stateHome" | "piConfigDir"
			readonly cause: CanonicalPathError
	  }
	| { readonly kind: "default-rules"; readonly cause: DefaultRulesError }

export interface InitialSafetyConfiguration {
	readonly filePolicy: FilePolicy
	readonly stateHome: CanonicalPath
}

export function parseInitialFilePolicy(raw: RawInitialFilePolicy): Result<FilePolicy, FilePolicyConfigurationError> {
	const configuration = parseInitialSafetyConfiguration(raw)
	return configuration.ok ? ok(configuration.value.filePolicy) : configuration
}

export function parseInitialSafetyConfiguration(
	raw: RawInitialFilePolicy,
): Result<InitialSafetyConfiguration, FilePolicyConfigurationError> {
	const workspace = parsePolicyPath("cwd", raw.cwd)
	if (!workspace.ok) return workspace
	const home = parsePolicyPath("home", raw.home)
	if (!home.ok) return home
	const stateHome = parsePolicyPath("stateHome", raw.stateHome)
	if (!stateHome.ok) return stateHome
	const piConfigDirectory = parsePolicyPath("piConfigDir", raw.piConfigDir)
	if (!piConfigDirectory.ok) return piConfigDirectory
	const paths: DefaultRulePaths = Object.freeze({
		workspace: workspace.value,
		home: home.value,
		stateHome: stateHome.value,
		piConfigDirectory: piConfigDirectory.value,
	})
	const policy = createDefaultFilePolicy({ paths, additionalNoAccessPatterns: raw.additionalNoAccessPatterns })
	if (!policy.ok) return err({ kind: "default-rules", cause: policy.error })
	return ok(Object.freeze({ filePolicy: policy.value, stateHome: stateHome.value }))
}

function parsePolicyPath(
	field: Extract<FilePolicyConfigurationError, { kind: "canonical-path" }>["field"],
	input: string,
): Result<CanonicalPath, FilePolicyConfigurationError> {
	const parsed = parseCanonicalPath(input)
	return parsed.ok ? parsed : err({ kind: "canonical-path", field, cause: parsed.error })
}

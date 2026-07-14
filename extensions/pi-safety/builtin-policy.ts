import * as path from "node:path"
import { type CanonicalPath, type CanonicalPathError, parseCanonicalPath } from "./canonical-path"
import { type ProtectedPathPattern, type ProtectedPathPatternError, parseProtectedPathPattern } from "./protected-path"
import { type Result, err, ok } from "./result"
import { type BuiltinAccessPolicy, createBuiltinAccessPolicy } from "./tool-authorization"

export interface RawInitialBuiltinAccessPolicy {
	readonly cwd: string
	readonly home: string
	readonly stateHome: string
	readonly piConfigDir: string
	readonly additionalSecretPatterns: readonly string[]
}

export type BuiltinPolicyError =
	| {
			readonly kind: "canonical-path"
			readonly field: "cwd" | "home" | "stateHome" | "piConfigDir"
			readonly cause: CanonicalPathError
	  }
	| {
			readonly kind: "protected-pattern"
			readonly field: "secret" | "protected-write" | "git-write" | "ssh-metadata" | "protected-snapshot"
			readonly input: string
			readonly cause: ProtectedPathPatternError
	  }

export interface InitialBuiltinConfiguration {
	readonly accessPolicy: BuiltinAccessPolicy
	readonly stateHome: CanonicalPath
}

export function parseInitialBuiltinAccessPolicy(
	raw: RawInitialBuiltinAccessPolicy,
): Result<BuiltinAccessPolicy, BuiltinPolicyError> {
	const configuration = parseInitialBuiltinConfiguration(raw)
	return configuration.ok ? ok(configuration.value.accessPolicy) : configuration
}

export function parseInitialBuiltinConfiguration(
	raw: RawInitialBuiltinAccessPolicy,
): Result<InitialBuiltinConfiguration, BuiltinPolicyError> {
	const cwd = parsePolicyPath("cwd", raw.cwd)
	if (!cwd.ok) return cwd
	const home = parsePolicyPath("home", raw.home)
	if (!home.ok) return home
	const stateHome = parsePolicyPath("stateHome", raw.stateHome)
	if (!stateHome.ok) return stateHome
	const piConfigDir = parsePolicyPath("piConfigDir", raw.piConfigDir)
	if (!piConfigDir.ok) return piConfigDir

	const projectSafetyConfig = parseCanonicalPath(path.join(cwd.value, ".pi", "pi-safety.json"))
	if (!projectSafetyConfig.ok) return err({ kind: "canonical-path", field: "cwd", cause: projectSafetyConfig.error })

	const snapshotStore = parseCanonicalPath(path.join(stateHome.value, "pi-safety", "snapshots"))
	if (!snapshotStore.ok) return err({ kind: "canonical-path", field: "stateHome", cause: snapshotStore.error })

	const sshRoot = parseCanonicalPath(path.join(home.value, ".ssh"))
	if (!sshRoot.ok) return err({ kind: "canonical-path", field: "home", cause: sshRoot.error })
	const sshReadableMetadata = parsePatterns(
		"ssh-metadata",
		[
			path.join(sshRoot.value, "**", "*.pub"),
			path.join(sshRoot.value, "config"),
			path.join(sshRoot.value, "config.d"),
			path.join(sshRoot.value, "config.d", "**"),
			path.join(sshRoot.value, "known_hosts"),
			path.join(sshRoot.value, "known_hosts.old"),
			path.join(sshRoot.value, "allowed_signers"),
			path.join(sshRoot.value, "authorized_keys"),
		],
		cwd.value,
	)
	if (!sshReadableMetadata.ok) return sshReadableMetadata

	const secretInputs = [
		path.join(home.value, ".aws"),
		path.join(home.value, ".cf"),
		path.join(piConfigDir.value, "auth.json"),
		path.join(cwd.value, "**", ".env"),
		path.join(cwd.value, "**", ".env.*"),
		path.join(cwd.value, "**", "*.env"),
		path.join(cwd.value, "**", "*.env.*"),
		...raw.additionalSecretPatterns,
	]
	const secretPatterns = parsePatterns("secret", secretInputs, cwd.value)
	if (!secretPatterns.ok) return secretPatterns

	const gitWritePatterns = parsePatterns(
		"git-write",
		[
			path.join(cwd.value, ".git", "hooks"),
			path.join(cwd.value, ".git", "config"),
			path.join(cwd.value, ".git", "config.worktree"),
		],
		cwd.value,
	)
	if (!gitWritePatterns.ok) return gitWritePatterns

	const protectedWritePatterns = parsePatterns(
		"protected-write",
		[
			path.join(cwd.value, ".pi"),
			path.join(cwd.value, ".mcp.json"),
			path.join(cwd.value, ".claude"),
			path.join(cwd.value, ".cursor", "rules"),
			path.join(cwd.value, ".cursor", "mcp.json"),
			path.join(cwd.value, ".github", "instructions"),
			path.join(cwd.value, ".github", "copilot-instructions.md"),
			path.join(cwd.value, ".vscode", "settings.json"),
			path.join(cwd.value, ".vscode", "tasks.json"),
			path.join(cwd.value, ".vscode", "mcp.json"),
			path.join(home.value, ".bashrc"),
			path.join(home.value, ".bash_profile"),
			path.join(home.value, ".profile"),
			path.join(home.value, ".zshrc"),
			path.join(home.value, ".zprofile"),
			path.join(home.value, ".gitconfig"),
			path.join(home.value, ".config", "git", "config"),
			path.join(home.value, ".config", "fish", "config.fish"),
		],
		cwd.value,
	)
	if (!protectedWritePatterns.ok) return protectedWritePatterns

	const protectedSnapshotPatterns = parsePatterns(
		"protected-snapshot",
		[
			path.join(snapshotStore.value, "*", "*", "protected"),
			path.join(snapshotStore.value, "*", "*", "protected", "**"),
		],
		cwd.value,
	)
	if (!protectedSnapshotPatterns.ok) return protectedSnapshotPatterns

	return ok(
		Object.freeze({
			accessPolicy: createBuiltinAccessPolicy({
				workspaceRoot: cwd.value,
				homeRoot: home.value,
				secretPatterns: secretPatterns.value,
				nonGitProtectedWritePatterns: protectedWritePatterns.value,
				gitWritePatterns: gitWritePatterns.value,
				ssh: { protectedRoot: sshRoot.value, readableMetadata: sshReadableMetadata.value },
				protectedSnapshotPatterns: protectedSnapshotPatterns.value,
				immutableWriteRoots: [snapshotStore.value, piConfigDir.value, projectSafetyConfig.value],
			}),
			stateHome: stateHome.value,
		}),
	)
}

function parsePolicyPath(
	field: Extract<BuiltinPolicyError, { kind: "canonical-path" }>["field"],
	input: string,
): Result<CanonicalPath, BuiltinPolicyError> {
	const parsed = parseCanonicalPath(input)
	return parsed.ok ? parsed : err({ kind: "canonical-path", field, cause: parsed.error })
}

function parsePatterns(
	field: Extract<BuiltinPolicyError, { kind: "protected-pattern" }>["field"],
	inputs: readonly string[],
	relativeTo: CanonicalPath,
): Result<readonly ProtectedPathPattern[], BuiltinPolicyError> {
	const patterns: ProtectedPathPattern[] = []
	for (const input of inputs) {
		const parsed = parseProtectedPathPattern(input, relativeTo)
		if (!parsed.ok) return err({ kind: "protected-pattern", field, input, cause: parsed.error })
		patterns.push(parsed.value)
	}
	return ok(Object.freeze(patterns))
}

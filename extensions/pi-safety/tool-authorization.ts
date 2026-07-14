import { type BuiltinToolPathError, resolveBuiltinToolPath } from "./builtin-tool-path"
import { type CanonicalPath, isCanonicalPathWithin } from "./canonical-path"
import { type ProtectedPathPattern, matchesProtectedPath } from "./protected-path"
import { type Result, err, ok } from "./result"

declare const builtinAccessPolicyBrand: unique symbol
declare const authorizedReadBrand: unique symbol
declare const authorizedWriteTargetBrand: unique symbol

export interface BuiltinAccessPolicy {
	readonly workspaceRoot: CanonicalPath
	readonly homeRoot: CanonicalPath
	readonly secretPatterns: readonly ProtectedPathPattern[]
	readonly protectedWritePatterns: readonly ProtectedPathPattern[]
	readonly gitWritePatterns: readonly ProtectedPathPattern[]
	readonly ssh: {
		readonly protectedRoot: CanonicalPath
		readonly readableMetadata: readonly ProtectedPathPattern[]
	}
	readonly protectedSnapshotPatterns: readonly ProtectedPathPattern[]
	readonly immutableWriteRoots: readonly CanonicalPath[]
	readonly [builtinAccessPolicyBrand]: true
}

export interface AuthorizedRead {
	readonly path: CanonicalPath
	readonly [authorizedReadBrand]: true
}

export interface AuthorizedWriteTarget {
	readonly path: CanonicalPath
	readonly [authorizedWriteTargetBrand]: true
}

type MutatingBuiltinTool = "write" | "edit"
type GuardedBuiltinTool = "read" | MutatingBuiltinTool

export type GuardedToolCall =
	| { readonly kind: "bash" }
	| { readonly kind: "read"; readonly source: AuthorizedRead }
	| { readonly kind: "write"; readonly target: AuthorizedWriteTarget }
	| { readonly kind: "edit"; readonly target: AuthorizedWriteTarget }
	| { readonly kind: "other" }

export type ToolAuthorizationError =
	| { readonly kind: "invalid-tool-input"; readonly tool: string; readonly reason: string }
	| {
			readonly kind: "path-resolution"
			readonly tool: GuardedBuiltinTool
			readonly cause: BuiltinToolPathError
	  }
	| { readonly kind: "secret-path"; readonly tool: GuardedBuiltinTool; readonly path: CanonicalPath }
	| { readonly kind: "protected-snapshot-path"; readonly tool: GuardedBuiltinTool; readonly path: CanonicalPath }
	| { readonly kind: "protected-write-path"; readonly tool: MutatingBuiltinTool; readonly path: CanonicalPath }
	| { readonly kind: "immutable-write-root"; readonly tool: MutatingBuiltinTool; readonly path: CanonicalPath }
	| {
			readonly kind: "outside-workspace"
			readonly tool: MutatingBuiltinTool
			readonly path: CanonicalPath
			readonly workspaceRoot: CanonicalPath
	  }

export function createBuiltinAccessPolicy(input: {
	readonly workspaceRoot: CanonicalPath
	readonly homeRoot: CanonicalPath
	readonly secretPatterns: readonly ProtectedPathPattern[]
	readonly nonGitProtectedWritePatterns: readonly ProtectedPathPattern[]
	readonly gitWritePatterns: readonly ProtectedPathPattern[]
	readonly ssh: {
		readonly protectedRoot: CanonicalPath
		readonly readableMetadata: readonly ProtectedPathPattern[]
	}
	readonly protectedSnapshotPatterns: readonly ProtectedPathPattern[]
	readonly immutableWriteRoots: readonly CanonicalPath[]
}): BuiltinAccessPolicy {
	return Object.freeze({
		workspaceRoot: input.workspaceRoot,
		homeRoot: input.homeRoot,
		secretPatterns: Object.freeze([...input.secretPatterns]),
		protectedWritePatterns: Object.freeze([...input.gitWritePatterns, ...input.nonGitProtectedWritePatterns]),
		gitWritePatterns: Object.freeze([...input.gitWritePatterns]),
		ssh: Object.freeze({
			protectedRoot: input.ssh.protectedRoot,
			readableMetadata: Object.freeze([...input.ssh.readableMetadata]),
		}),
		protectedSnapshotPatterns: Object.freeze([...input.protectedSnapshotPatterns]),
		immutableWriteRoots: Object.freeze([...input.immutableWriteRoots]),
	}) as BuiltinAccessPolicy
}

export function authorizeBuiltinToolCall(
	toolName: string,
	input: unknown,
	policy: BuiltinAccessPolicy,
): Result<GuardedToolCall, ToolAuthorizationError> {
	if (toolName === "bash") {
		if (typeof input !== "object" || input === null || !("command" in input) || typeof input.command !== "string") {
			return err({ kind: "invalid-tool-input", tool: toolName, reason: "expected an object with a string command" })
		}
		return ok({ kind: "bash" })
	}
	if (toolName !== "read" && toolName !== "write" && toolName !== "edit") return ok({ kind: "other" })
	const rawPath = readPathArgument(toolName, input)
	if (!rawPath.ok) return rawPath

	const resolvedPath = resolveBuiltinToolPath(
		rawPath.value,
		policy.workspaceRoot,
		policy.homeRoot,
		toolName === "read" ? "read" : "write-target",
	)
	if (!resolvedPath.ok) return err({ kind: "path-resolution", tool: toolName, cause: resolvedPath.error })

	if (policy.secretPatterns.some((pattern) => matchesProtectedPath(pattern, resolvedPath.value))) {
		return err({ kind: "secret-path", tool: toolName, path: resolvedPath.value })
	}
	if (
		isCanonicalPathWithin(policy.ssh.protectedRoot, resolvedPath.value) &&
		(toolName !== "read" ||
			!policy.ssh.readableMetadata.some((pattern) => matchesProtectedPath(pattern, resolvedPath.value)))
	) {
		return err({ kind: "secret-path", tool: toolName, path: resolvedPath.value })
	}
	if (policy.protectedSnapshotPatterns.some((pattern) => matchesProtectedPath(pattern, resolvedPath.value))) {
		return err({ kind: "protected-snapshot-path", tool: toolName, path: resolvedPath.value })
	}
	if (toolName === "read") {
		return ok({ kind: "read", source: Object.freeze({ path: resolvedPath.value }) as AuthorizedRead })
	}
	if (policy.immutableWriteRoots.some((root) => isCanonicalPathWithin(root, resolvedPath.value))) {
		return err({ kind: "immutable-write-root", tool: toolName, path: resolvedPath.value })
	}
	if (policy.protectedWritePatterns.some((pattern) => matchesProtectedPath(pattern, resolvedPath.value))) {
		return err({ kind: "protected-write-path", tool: toolName, path: resolvedPath.value })
	}
	if (!isCanonicalPathWithin(policy.workspaceRoot, resolvedPath.value)) {
		return err({
			kind: "outside-workspace",
			tool: toolName,
			path: resolvedPath.value,
			workspaceRoot: policy.workspaceRoot,
		})
	}

	const target = Object.freeze({ path: resolvedPath.value }) as AuthorizedWriteTarget
	return toolName === "write" ? ok({ kind: "write", target }) : ok({ kind: "edit", target })
}

function readPathArgument(
	tool: string,
	input: unknown,
): Result<string, Extract<ToolAuthorizationError, { kind: "invalid-tool-input" }>> {
	if (typeof input !== "object" || input === null || !("path" in input) || typeof input.path !== "string") {
		return err({ kind: "invalid-tool-input", tool, reason: "expected an object with a string path" })
	}
	return ok(input.path)
}

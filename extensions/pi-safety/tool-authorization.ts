import { type BuiltinToolPathError, resolveBuiltinToolPath } from "./builtin-tool-path"
import type { CanonicalPath } from "./canonical-path"
import { type FileAccess, type FilePolicy, decideFileAccess } from "./file-policy"
import { type Result, err, ok } from "./result"

declare const authorizedReadBrand: unique symbol
declare const authorizedWriteTargetBrand: unique symbol

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
	| {
			readonly kind: "access-denied"
			readonly tool: GuardedBuiltinTool
			readonly path: CanonicalPath
			readonly required: "read" | "write"
			readonly actual: FileAccess
			readonly label: string | undefined
	  }

export function authorizeBuiltinToolCall(
	toolName: string,
	input: unknown,
	policy: FilePolicy,
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

	const decision = decideFileAccess(policy, resolvedPath.value)
	if (toolName === "read") {
		if (decision.value === "none") return denied(toolName, resolvedPath.value, "read", decision)
		return ok({ kind: "read", source: Object.freeze({ path: resolvedPath.value }) as AuthorizedRead })
	}
	if (decision.value !== "read-write") return denied(toolName, resolvedPath.value, "write", decision)

	const target = Object.freeze({ path: resolvedPath.value }) as AuthorizedWriteTarget
	return toolName === "write" ? ok({ kind: "write", target }) : ok({ kind: "edit", target })
}

function denied(
	tool: GuardedBuiltinTool,
	path: CanonicalPath,
	required: "read" | "write",
	decision: ReturnType<typeof decideFileAccess>,
): Result<never, ToolAuthorizationError> {
	return err({
		kind: "access-denied",
		tool,
		path,
		required,
		actual: decision.value,
		label: decision.rule?.label,
	})
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

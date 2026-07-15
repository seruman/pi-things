import { z } from "zod"
import { type BuiltinToolPathError, resolveBuiltinToolPath } from "./builtin-tool-path"
import type { CanonicalPath } from "./canonical-path"
import { type FileAccess, type FilePolicy, decideFileAccess } from "./file-policy"
import { type Result, err, ok } from "./result"

type MutatingBuiltinTool = "write" | "edit"
type GuardedBuiltinTool = "read" | MutatingBuiltinTool

const bashInputSchema = z.object({ command: z.string() }).passthrough()
const pathInputSchema = z.object({ path: z.string() }).passthrough()

export type GuardedToolCall =
	| { readonly kind: "bash" }
	| { readonly kind: "read" }
	| { readonly kind: "write" }
	| { readonly kind: "edit" }
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
		if (!bashInputSchema.safeParse(input).success) {
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
		return ok({ kind: "read" })
	}
	if (decision.value !== "read-write") return denied(toolName, resolvedPath.value, "write", decision)

	return ok({ kind: toolName })
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
	const decoded = pathInputSchema.safeParse(input)
	if (!decoded.success) {
		return err({ kind: "invalid-tool-input", tool, reason: "expected an object with a string path" })
	}
	return ok(decoded.data.path)
}

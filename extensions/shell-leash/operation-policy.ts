import { githubOperationIds } from "./github-operations"

const GIT_OPERATIONS = ["git.push", "git.push.force", "git.push.delete"] as const

export function describeRemoteOperationPolicy(): string {
	return [
		"Shell Leash remote operation policy",
		"",
		"Known mutations require an invocation permit or matching request lease.",
		"Unknown and dynamic states are allowed statically, observed, and checked again by focused runtime shims.",
		"",
		"Git mutations:",
		...GIT_OPERATIONS.map((operation) => `  ${operation}`),
		"",
		"GitHub mutations:",
		...githubOperationIds().map((operation) => `  ${operation}`),
	].join("\n")
}

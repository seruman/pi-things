const MUTATING_COMMAND_PATHS = [
	["repo", "create"],
	["repo", "delete"],
	["repo", "archive"],
	["repo", "unarchive"],
	["repo", "edit"],
	["repo", "fork"],
	["repo", "rename"],
	["repo", "sync"],
	["repo", "deploy-key"],
	["repo", "autolink"],
	["pr", "create"],
	["pr", "comment"],
	["pr", "edit"],
	["pr", "review"],
	["pr", "ready"],
	["pr", "update-branch"],
	["pr", "close"],
	["pr", "reopen"],
	["pr", "merge"],
	["pr", "revert"],
	["pr", "lock"],
	["pr", "unlock"],
	["issue", "create"],
	["issue", "comment"],
	["issue", "edit"],
	["issue", "close"],
	["issue", "reopen"],
	["issue", "develop"],
	["issue", "delete"],
	["issue", "transfer"],
	["issue", "lock"],
	["issue", "unlock"],
	["issue", "pin"],
	["issue", "unpin"],
	["release", "create"],
	["release", "edit"],
	["release", "delete"],
	["release", "delete-asset"],
	["release", "upload"],
	["gist", "clone"],
	["gist", "create"],
	["gist", "edit"],
	["gist", "delete"],
	["gist", "rename"],
	["secret", "set"],
	["secret", "delete"],
	["variable", "set"],
	["variable", "delete"],
	["run", "rerun"],
	["run", "cancel"],
	["run", "delete"],
	["workflow", "run"],
	["workflow", "enable"],
	["workflow", "disable"],
	["label", "create"],
	["label", "edit"],
	["label", "delete"],
	["label", "clone"],
	["cache", "delete"],
	["auth", "login"],
	["auth", "logout"],
	["auth", "refresh"],
	["auth", "setup-git"],
	["auth", "switch"],
	["config", "set"],
	["extension", "install"],
	["extension", "remove"],
	["extension", "upgrade"],
	["extension", "create"],
	["extension", "exec"],
	["extension", "browse"],
	["ssh-key", "add"],
	["ssh-key", "delete"],
	["gpg-key", "add"],
	["gpg-key", "delete"],
] as const

const READ_COMMAND_PATHS = [
	["repo", "view"],
	["repo", "list"],
	["repo", "set-default"],
	["repo", "gitignore"],
	["repo", "license"],
	["pr", "list"],
	["pr", "view"],
	["pr", "status"],
	["pr", "diff"],
	["pr", "checks"],
	["pr", "checkout"],
	["issue", "list"],
	["issue", "view"],
	["issue", "status"],
	["release", "list"],
	["release", "view"],
	["release", "download"],
	["release", "verify"],
	["release", "verify-asset"],
	["gist", "view"],
	["gist", "list"],
	["secret", "list"],
	["variable", "list"],
	["variable", "get"],
	["run", "list"],
	["run", "view"],
	["run", "download"],
	["run", "watch"],
	["workflow", "list"],
	["workflow", "view"],
	["label", "list"],
	["cache", "list"],
	["auth", "status"],
	["auth", "token"],
	["config", "list"],
	["config", "get"],
	["config", "clear-cache"],
	["extension", "list"],
	["extension", "search"],
	["ssh-key", "list"],
	["gpg-key", "list"],
	["org", "list"],
	["project", "list"],
	["project", "view"],
	["project", "field-list"],
	["project", "item-list"],
] as const

type MutatingPath = (typeof MUTATING_COMMAND_PATHS)[number]
export type GitHubCommandOperation = `gh.${MutatingPath[0]}.${MutatingPath[1]}`
export type GitHubWildcardOperation =
	| "gh.project.mutate"
	| "gh.codespace.mutate"
	| "gh.agent-task.mutate"
	| "gh.skill.mutate"
export type GitHubOperation = "gh.api.write" | GitHubCommandOperation | GitHubWildcardOperation

const mutatingByPath = new Map<string, GitHubCommandOperation>(
	MUTATING_COMMAND_PATHS.map(([group, action]) => [`${group} ${action}`, `gh.${group}.${action}`]),
)
const readPaths = new Set<string>(READ_COMMAND_PATHS.map(([group, action]) => `${group} ${action}`))
const wildcardReadGroups = new Set(["search", "ruleset", "attestation", "copilot"])
const commandOperationIds = new Set<string>(mutatingByPath.values())

export function githubCommandOperation(group: string, action: string): GitHubOperation | undefined {
	const key = `${group} ${action}`
	return mutatingByPath.get(key) ?? (readPaths.has(key) ? undefined : wildcardOperation(group))
}

export function isReadOnlyGitHubCommand(group: string, action: string): boolean {
	return readPaths.has(`${group} ${action}`) || wildcardReadGroups.has(group)
}

export function isGitHubOperation(input: unknown): input is GitHubOperation {
	if (input === "gh.api.write") return true
	if (typeof input !== "string" || !input.startsWith("gh.")) return false
	return commandOperationIds.has(input) || wildcardOperation(input.split(".")[1] ?? "") === input
}

export function githubOperationIds(): readonly GitHubOperation[] {
	return [
		"gh.api.write",
		...mutatingByPath.values(),
		"gh.project.mutate",
		"gh.codespace.mutate",
		"gh.agent-task.mutate",
		"gh.skill.mutate",
	]
}

export function githubReadOnlyCommandPaths(): readonly (readonly [string, string])[] {
	return READ_COMMAND_PATHS
}

function wildcardOperation(group: string): GitHubWildcardOperation | undefined {
	switch (group) {
		case "project":
			return "gh.project.mutate"
		case "codespace":
			return "gh.codespace.mutate"
		case "agent-task":
			return "gh.agent-task.mutate"
		case "skill":
			return "gh.skill.mutate"
		default:
			return undefined
	}
}

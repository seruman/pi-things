import type { GitHubOperation } from "./github-operations"

export type { GitHubOperation } from "./github-operations"

export type GitPushOperation = "git.push" | "git.push.force" | "git.push.delete"

export type GitRemoteTarget =
	| { readonly kind: "named"; readonly name: string }
	| { readonly kind: "url"; readonly url: string }
	| { readonly kind: "implicit" }
	| { readonly kind: "unknown"; readonly source: string }

export type GitRefspec =
	| { readonly kind: "source"; readonly source: string }
	| { readonly kind: "mapping"; readonly source: string; readonly destination: string }
	| { readonly kind: "delete"; readonly destination: string }
	| { readonly kind: "unknown"; readonly source: string }

export type RepositoryTarget =
	| { readonly kind: "unknown" }
	| { readonly kind: "repository"; readonly host: string; readonly owner: string; readonly repository: string }

export type GitPushDetails = {
	readonly force: "none" | "force" | "force-with-lease"
	readonly destination: "implicit" | "explicit"
	readonly all: boolean
	readonly mirror: boolean
	readonly tags: boolean
	readonly prune: boolean
}

export type GitPushEffect = {
	readonly kind: "git-push"
	readonly operation: GitPushOperation
	readonly remote: GitRemoteTarget
	readonly refspecs: readonly GitRefspec[]
	readonly repository: RepositoryTarget
	readonly details: GitPushDetails
}

export type GitHubTarget =
	| { readonly kind: "unknown" }
	| { readonly kind: "repository"; readonly host: string; readonly owner: string; readonly repository: string }

export type GitHubOperationDetails =
	| {
			readonly object:
				| { readonly kind: "issue"; readonly number?: number }
				| { readonly kind: "pull-request"; readonly number?: number }
	  }
	| { readonly api: { readonly method: string; readonly endpoint: string } }
	| { readonly command: { readonly group: string; readonly action: string; readonly arguments: readonly string[] } }

export type GitHubEffect = {
	readonly kind: "github"
	readonly operation: GitHubOperation
	readonly target: GitHubTarget
	readonly details: GitHubOperationDetails
}

export type RemoteEffect = GitPushEffect | GitHubEffect

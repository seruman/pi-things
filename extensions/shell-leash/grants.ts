import type { GitHubEffect, GitPushEffect, RemoteEffect } from "./effects"
import type { EffectFinding } from "./findings"

export type InvocationPermit = {
	readonly toolCallId: string
	readonly effects: readonly RemoteEffect[]
}

export type RemoteTargetScope =
	| { readonly kind: "any" }
	| { readonly kind: "repository"; readonly host: string; readonly owner: string; readonly repository: string }
	| {
			readonly kind: "git-push-target"
			readonly repository: Extract<GitPushEffect["repository"], { readonly kind: "repository" }>
			readonly remote: Exclude<GitPushEffect["remote"], { readonly kind: "unknown" }>
	  }

export type RequestLease = {
	readonly requestId: string
	readonly operation: RemoteEffect["operation"]
	readonly target: RemoteTargetScope
}

export type RemoteDecision =
	| { readonly kind: "allow" }
	| { readonly kind: "ask"; readonly findings: readonly EffectFinding[] }

export function createInvocationPermit(toolCallId: string, effects: readonly RemoteEffect[]): InvocationPermit {
	return { toolCallId, effects }
}

export function createRequestLease(
	requestId: string,
	operation: RemoteEffect["operation"],
	target: RemoteTargetScope,
): RequestLease {
	return { requestId, operation, target }
}

export function decideRemoteEffects(input: {
	readonly toolCallId: string
	readonly requestId: string
	readonly findings: readonly EffectFinding[]
	readonly permits: readonly InvocationPermit[]
	readonly leases: readonly RequestLease[]
}): RemoteDecision {
	const ungranted = input.findings.filter(
		(finding) =>
			!input.permits.some(
				(permit) =>
					permit.toolCallId === input.toolCallId &&
					permit.effects.some((approved) => invocationEffectMatches(approved, finding.effect)),
			) &&
			!input.leases.some(
				(lease) =>
					lease.requestId === input.requestId &&
					lease.operation === finding.effect.operation &&
					targetScopeMatches(lease.target, finding.effect),
			),
	)
	return ungranted.length === 0 ? { kind: "allow" } : { kind: "ask", findings: ungranted }
}

function invocationEffectMatches(approved: RemoteEffect, actual: RemoteEffect): boolean {
	if (approved.operation !== actual.operation || approved.kind !== actual.kind) return false
	switch (approved.kind) {
		case "git-push":
			return actual.kind === "git-push" && gitPushMatches(approved, actual)
		case "github":
			return actual.kind === "github" && githubMatches(approved, actual)
		default:
			return approved satisfies never
	}
}

function gitPushMatches(approved: GitPushEffect, actual: GitPushEffect): boolean {
	if (!repositoryMatches(approved.repository, actual.repository)) return false
	if (approved.remote.kind !== "unknown" && JSON.stringify(approved.remote) !== JSON.stringify(actual.remote))
		return false
	if (approved.refspecs.length !== actual.refspecs.length) return false
	return approved.refspecs.every((refspec, index) => {
		if (refspec.kind === "unknown") return true
		return JSON.stringify(refspec) === JSON.stringify(actual.refspecs[index])
	})
}

function githubMatches(approved: GitHubEffect, actual: GitHubEffect): boolean {
	if (!githubTargetMatches(approved.target, actual.target)) return false
	return JSON.stringify(approved.details) === JSON.stringify(actual.details)
}

function targetScopeMatches(scope: RemoteTargetScope, effect: RemoteEffect): boolean {
	if (scope.kind === "any") return true
	if (scope.kind === "git-push-target") {
		return (
			effect.kind === "git-push" &&
			effect.repository.kind === "repository" &&
			repositoryIdentityEquals(scope.repository, effect.repository) &&
			JSON.stringify(scope.remote) === JSON.stringify(effect.remote)
		)
	}
	return effect.kind === "git-push"
		? effect.repository.kind === "repository" && repositoryIdentityEquals(scope, effect.repository)
		: effect.target.kind === "repository" && repositoryIdentityEquals(scope, effect.target)
}

function repositoryMatches(approved: GitPushEffect["repository"], actual: GitPushEffect["repository"]): boolean {
	return approved.kind === "unknown" || (actual.kind === "repository" && repositoryIdentityEquals(approved, actual))
}

function githubTargetMatches(approved: GitHubEffect["target"], actual: GitHubEffect["target"]): boolean {
	return approved.kind === "unknown" || (actual.kind === "repository" && repositoryIdentityEquals(approved, actual))
}

function repositoryIdentityEquals(
	left: { readonly host: string; readonly owner: string; readonly repository: string },
	right: { readonly host: string; readonly owner: string; readonly repository: string },
): boolean {
	return left.host === right.host && left.owner === right.owner && left.repository === right.repository
}

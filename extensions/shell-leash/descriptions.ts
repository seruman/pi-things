import type { GitPushEffect, GitRefspec, GitRemoteTarget, RemoteEffect } from "./effects"
import type { EffectFinding } from "./findings"
import type { RemoteTargetScope } from "./grants"

export function describeFindings(findings: readonly EffectFinding[]): string {
	return findings
		.map((finding) => {
			const effect = describeEffect(finding.effect)
			return finding.evidence.source ? `${effect}\nsource: ${finding.evidence.source.kind}` : effect
		})
		.join("\n\n")
}

export function requestLeaseScope(finding: EffectFinding): RemoteTargetScope | undefined {
	const effect = finding.effect
	if (effect.kind === "git-push") {
		return effect.repository.kind === "repository" && effect.remote.kind !== "unknown"
			? { kind: "git-push-target", repository: effect.repository, remote: effect.remote }
			: undefined
	}
	return effect.target.kind === "repository"
		? {
				kind: "repository",
				host: effect.target.host,
				owner: effect.target.owner,
				repository: effect.target.repository,
			}
		: undefined
}

function describeEffect(effect: RemoteEffect): string {
	switch (effect.kind) {
		case "git-push":
			return describeGitPush(effect)
		case "github": {
			const target =
				effect.target.kind === "repository"
					? `${effect.target.host}/${effect.target.owner}/${effect.target.repository}`
					: "unknown"
			return [`operation: ${effect.operation}`, `target: ${target}`, describeGitHubDetails(effect.details)].join("\n")
		}
		default:
			return effect satisfies never
	}
}

function describeGitPush(effect: GitPushEffect): string {
	return [
		`operation: ${effect.operation}`,
		`remote: ${describeRemote(effect.remote)}`,
		`refs: ${effect.refspecs.length === 0 ? "implicit" : effect.refspecs.map(describeRefspec).join(", ")}`,
	].join("\n")
}

function describeRemote(remote: GitRemoteTarget): string {
	switch (remote.kind) {
		case "named":
			return remote.name
		case "url":
			return remote.url
		case "implicit":
			return "implicit"
		case "unknown":
			return `unknown (${remote.source})`
		default:
			return remote satisfies never
	}
}

function describeRefspec(refspec: GitRefspec): string {
	switch (refspec.kind) {
		case "source":
			return refspec.source
		case "mapping":
			return `${refspec.source} -> ${refspec.destination}`
		case "delete":
			return `delete ${refspec.destination}`
		case "unknown":
			return `unknown (${refspec.source})`
		default:
			return refspec satisfies never
	}
}

function describeGitHubDetails(details: Extract<RemoteEffect, { readonly kind: "github" }>["details"]): string {
	if ("api" in details) return `request: ${details.api.method} ${details.api.endpoint}`
	if ("command" in details) return `command: ${details.command.group} ${details.command.action}`
	const number = details.object.number === undefined ? "new" : String(details.object.number)
	return `object: ${details.object.kind} ${number}`
}

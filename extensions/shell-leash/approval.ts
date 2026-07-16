import { describeFindings, requestLeaseScope } from "./descriptions"
import type { EffectFinding } from "./findings"
import type { RemoteTargetScope } from "./grants"

export type RemoteRequestGrant = {
	readonly finding: EffectFinding
	readonly scope: RemoteTargetScope
}

export type RemoteApprovalChoice =
	| { readonly kind: "allow-once" }
	| { readonly kind: "allow-request"; readonly grants: readonly RemoteRequestGrant[] }
	| { readonly kind: "deny" }

export async function requestRemoteApproval(
	findings: readonly EffectFinding[],
	select: (prompt: string, options: string[]) => Promise<string | undefined>,
): Promise<RemoteApprovalChoice> {
	const allowOnce = "Allow once"
	const deny = "Deny"
	const requestGrants = findings.length === 1 && findings[0] ? requestGrantOptions(findings[0]) : []
	const chooseRequestGrants = "Approve this call and select request grants…"
	const options = [
		allowOnce,
		...(findings.length > 1 ? [chooseRequestGrants] : requestGrants.map((grant) => grant.label)),
		deny,
	]
	const choice = await select(`shell-leash\n${describeFindings(findings)}`, options)
	if (choice === allowOnce) return { kind: "allow-once" }
	const requestGrant = requestGrants.find((grant) => choice === grant.label)
	if (requestGrant) return { kind: "allow-request", grants: [requestGrant] }
	if (choice !== chooseRequestGrants) return { kind: "deny" }

	const selected: RemoteRequestGrant[] = []
	for (const finding of findings) {
		const grants = requestGrantOptions(finding)
		const skip = `Do not grant ${finding.effect.operation} for this request`
		const selectedLabel = await select(`Request grant for ${describeFindings([finding])}`, [
			...grants.map((grant) => grant.label),
			skip,
		])
		if (selectedLabel === undefined) return { kind: "deny" }
		const grant = grants.find((candidate) => candidate.label === selectedLabel)
		if (grant) selected.push(grant)
	}
	return selected.length > 0 ? { kind: "allow-request", grants: selected } : { kind: "allow-once" }
}

function requestGrantOptions(finding: EffectFinding): readonly (RemoteRequestGrant & { readonly label: string })[] {
	const narrowScope = requestLeaseScope(finding)
	const scopes: readonly RemoteTargetScope[] = narrowScope ? [narrowScope, { kind: "any" }] : [{ kind: "any" }]
	return scopes.map((scope) => ({
		finding,
		scope,
		label: `Allow ${finding.effect.operation} for ${describeScope(scope)} this request`,
	}))
}

export function describeScope(scope: RemoteTargetScope): string {
	switch (scope.kind) {
		case "any":
			return "any target"
		case "repository":
			return `${scope.host}/${scope.owner}/${scope.repository}`
		case "git-push-target": {
			const repository = `${scope.repository.host}/${scope.repository.owner}/${scope.repository.repository}`
			const remote =
				scope.remote.kind === "named" ? scope.remote.name : scope.remote.kind === "url" ? scope.remote.url : "implicit"
			return `${repository} via ${remote}`
		}
		default:
			return scope satisfies never
	}
}

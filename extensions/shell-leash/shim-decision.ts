import { analyzeResolvedCommand } from "./analyze-command"
import { describeFindings } from "./descriptions"
import type { GitHubTarget, RepositoryTarget } from "./effects"
import type { AnalysisObservation } from "./findings"
import { decideRemoteEffects } from "./grants"
import type { InvocationManifest } from "./invocation-manifest"

export type ShimDecision =
	| { readonly kind: "delegate"; readonly observations: readonly AnalysisObservation[] }
	| {
			readonly kind: "block"
			readonly operations: readonly string[]
			readonly reason: string
			readonly observations: readonly AnalysisObservation[]
	  }

export function decideShimInvocation(
	manifest: InvocationManifest,
	argv: readonly string[],
	cwd: string,
	repository: RepositoryTarget = { kind: "unknown" },
	githubRepository?: GitHubTarget,
	gitRemotes?: ReadonlyMap<string, string>,
	gitDefaultBranch?: string,
): ShimDecision {
	const analysis = analyzeResolvedCommand({ argv, cwd, repository, githubRepository, gitRemotes, gitDefaultBranch })
	const decision = decideRemoteEffects({
		toolCallId: manifest.toolCallId,
		requestId: manifest.requestId,
		findings: analysis.findings,
		permits: [manifest.permit],
		leases: manifest.leases,
	})
	if (decision.kind === "allow") return { kind: "delegate", observations: analysis.observations }
	const operations = [...new Set(decision.findings.map((finding) => finding.effect.operation))]
	return {
		kind: "block",
		operations,
		reason: [
			"shell-leash blocked a runtime-discovered remote mutation",
			describeFindings(decision.findings),
			"reason: no pre-execution grant matched the resolved argv",
			"human action: rerun an explicit Bash command and approve it; choose a request scope in the approval menu for repeated work",
		].join("\n"),
		observations: analysis.observations,
	}
}

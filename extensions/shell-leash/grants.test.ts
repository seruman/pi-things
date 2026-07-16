import { describe, expect, test } from "bun:test"
import { analyzeResolvedCommand } from "./analyze-command"
import { requestLeaseScope } from "./descriptions"
import { createInvocationPermit, createRequestLease, decideRemoteEffects } from "./grants"

describe("remote grants", () => {
	test("an allow-once permit applies only to the approved Bash tool call", () => {
		const findings = analyzeResolvedCommand({ argv: ["git", "push", "origin", "main"], cwd: "/workspace" }).findings
		const permit = createInvocationPermit(
			"bash-1",
			findings.map((finding) => finding.effect),
		)

		expect(
			decideRemoteEffects({ toolCallId: "bash-1", requestId: "request-1", findings, permits: [permit], leases: [] }),
		).toEqual({ kind: "allow" })
		expect(
			decideRemoteEffects({ toolCallId: "bash-2", requestId: "request-1", findings, permits: [permit], leases: [] }),
		).toEqual({ kind: "ask", findings })
	})

	test("an ordinary push permit never authorizes a force push", () => {
		const ordinary = analyzeResolvedCommand({ argv: ["git", "push", "origin", "main"], cwd: "/workspace" }).findings
		const forced = analyzeResolvedCommand({
			argv: ["git", "push", "--force", "origin", "main"],
			cwd: "/workspace",
		}).findings
		const permit = createInvocationPermit(
			"bash-1",
			ordinary.map((finding) => finding.effect),
		)

		expect(
			decideRemoteEffects({
				toolCallId: "bash-1",
				requestId: "request-1",
				findings: forced,
				permits: [permit],
				leases: [],
			}),
		).toEqual({ kind: "ask", findings: forced })
	})

	test("a Git push request lease covers only the same operation, repository, and remote", () => {
		const repository = {
			kind: "repository" as const,
			host: "github.com",
			owner: "octocat",
			repository: "hello-world",
		}
		const otherRepository = { ...repository, repository: "other" }
		const ordinary = analyzeResolvedCommand({ argv: ["git", "push", "origin", "main"], cwd: "/workspace", repository })
		const finding = ordinary.findings[0]
		if (!finding) throw new Error("expected ordinary push finding")
		const scope = requestLeaseScope(finding)
		if (!scope) throw new Error("expected Git push target scope")
		const lease = createRequestLease("request-1", "git.push", scope)
		const cases: readonly {
			readonly analysis: ReturnType<typeof analyzeResolvedCommand>
			readonly decision: "allow" | "ask"
		}[] = [
			{
				analysis: analyzeResolvedCommand({ argv: ["git", "push", "origin", "next"], cwd: "/workspace", repository }),
				decision: "allow",
			},
			{
				analysis: analyzeResolvedCommand({
					argv: ["git", "push", "--force", "origin", "main"],
					cwd: "/workspace",
					repository,
				}),
				decision: "ask",
			},
			{
				analysis: analyzeResolvedCommand({
					argv: ["git", "push", "--delete", "origin", "main"],
					cwd: "/workspace",
					repository,
				}),
				decision: "ask",
			},
			{
				analysis: analyzeResolvedCommand({
					argv: ["git", "push", "origin", "main"],
					cwd: "/workspace",
					repository: otherRepository,
				}),
				decision: "ask",
			},
		]
		for (const entry of cases) {
			expect(
				decideRemoteEffects({
					toolCallId: "bash-2",
					requestId: "request-1",
					findings: entry.analysis.findings,
					permits: [],
					leases: [lease],
				}).kind,
			).toBe(entry.decision)
		}
	})

	test("a generated Git push lease does not authorize another named remote", () => {
		const repository = {
			kind: "repository" as const,
			host: "github.com",
			owner: "octocat",
			repository: "hello-world",
		}
		const origin = analyzeResolvedCommand({ argv: ["git", "push", "origin", "main"], cwd: "/workspace", repository })
		const fork = analyzeResolvedCommand({ argv: ["git", "push", "fork", "main"], cwd: "/workspace", repository })
		const finding = origin.findings[0]
		if (!finding) throw new Error("expected origin push finding")
		const scope = requestLeaseScope(finding)
		if (!scope) throw new Error("expected Git push target scope")
		const lease = createRequestLease("request-1", "git.push", scope)

		expect(
			decideRemoteEffects({
				toolCallId: "bash-2",
				requestId: "request-1",
				findings: fork.findings,
				permits: [],
				leases: [lease],
			}),
		).toEqual({ kind: "ask", findings: fork.findings })
	})

	test("a repository-scoped request lease expires at the next request", () => {
		const findings = analyzeResolvedCommand({
			argv: ["gh", "-R", "octocat/hello-world", "issue", "comment", "123", "--body", "done"],
			cwd: "/workspace",
		}).findings
		const lease = createRequestLease("request-1", "gh.issue.comment", {
			kind: "repository",
			host: "github.com",
			owner: "octocat",
			repository: "hello-world",
		})

		expect(
			decideRemoteEffects({ toolCallId: "bash-2", requestId: "request-1", findings, permits: [], leases: [lease] }),
		).toEqual({ kind: "allow" })
		expect(
			decideRemoteEffects({ toolCallId: "bash-3", requestId: "request-2", findings, permits: [], leases: [lease] }),
		).toEqual({ kind: "ask", findings })
	})
})

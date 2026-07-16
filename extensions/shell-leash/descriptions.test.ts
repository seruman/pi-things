import { describe, expect, test } from "bun:test"
import { analyzeResolvedCommand } from "./analyze-command"
import { describeFindings, requestLeaseScope } from "./descriptions"

describe("remote effect descriptions", () => {
	test("shows the operation, remote, and refs before approval", () => {
		const findings = analyzeResolvedCommand({
			argv: ["git", "push", "--force-with-lease", "origin", "main:main"],
			cwd: "/workspace",
		}).findings

		expect(describeFindings(findings)).toContain("git.push.force")
		expect(describeFindings(findings)).toContain("remote: origin")
		expect(describeFindings(findings)).toContain("refs: main -> main")
	})

	test("shows the static command source path before approval", () => {
		const finding = analyzeResolvedCommand({
			argv: ["git", "push", "origin", "main"],
			cwd: "/workspace",
		}).findings[0]
		if (!finding) throw new Error("expected finding")
		expect(
			describeFindings([
				{
					...finding,
					evidence: { ...finding.evidence, source: { kind: "command-substitution", startByte: 4, endByte: 30 } },
				},
			]),
		).toContain("source: command-substitution")
	})

	test("shows GitHub repository and issue context before approval", () => {
		const findings = analyzeResolvedCommand({
			argv: ["gh", "-R", "octocat/hello-world", "issue", "comment", "123", "--body", "done"],
			cwd: "/workspace",
		}).findings
		const description = describeFindings(findings)
		expect(description).toContain("gh.issue.comment")
		expect(description).toContain("github.com/octocat/hello-world")
		expect(description).toContain("object: issue 123")
	})

	test("derives a request lease only from a known repository target", () => {
		const known = analyzeResolvedCommand({
			argv: ["gh", "-R", "octocat/hello-world", "issue", "comment", "123", "--body", "done"],
			cwd: "/workspace",
		}).findings[0]
		const unknown = analyzeResolvedCommand({
			argv: ["gh", "issue", "comment", "123", "--body", "done"],
			cwd: "/workspace",
		}).findings[0]

		expect(known && requestLeaseScope(known)).toEqual({
			kind: "repository",
			host: "github.com",
			owner: "octocat",
			repository: "hello-world",
		})
		expect(unknown && requestLeaseScope(unknown)).toBeUndefined()
	})
})

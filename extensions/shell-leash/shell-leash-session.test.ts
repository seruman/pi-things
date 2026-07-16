import { describe, expect, test } from "bun:test"
import { analyzeResolvedCommand } from "./analyze-command"
import { ShellLeashSession } from "./shell-leash-session"

describe("ShellLeashSession", () => {
	test("consumes an allow-once permit when its Bash tool call finishes", () => {
		const findings = analyzeResolvedCommand({ argv: ["git", "push", "origin", "main"], cwd: "/workspace" }).findings
		const session = new ShellLeashSession()
		session.beginRequest("request-1")

		expect(session.review("bash-1", findings)).toEqual({ kind: "ask", findings })
		session.allowOnce("bash-1", findings)
		expect(session.review("bash-1", findings)).toEqual({ kind: "allow" })
		session.finishToolCall("bash-1")
		expect(session.review("bash-1", findings)).toEqual({ kind: "ask", findings })
	})

	test("clears request leases at the next submitted request", () => {
		const findings = analyzeResolvedCommand({
			argv: ["gh", "-R", "octocat/hello-world", "issue", "comment", "123", "--body", "done"],
			cwd: "/workspace",
		}).findings
		const session = new ShellLeashSession()
		session.beginRequest("request-1")
		session.allowForRequest("gh.issue.comment", {
			kind: "repository",
			host: "github.com",
			owner: "octocat",
			repository: "hello-world",
		})
		expect(session.review("bash-1", findings)).toEqual({ kind: "allow" })
		expect(session.activeRequestLeases()).toHaveLength(1)
		expect(session.authorizationSnapshot("bash-1")).toEqual({
			requestId: "request-1",
			permit: { toolCallId: "bash-1", effects: [] },
			leases: [
				{
					requestId: "request-1",
					operation: "gh.issue.comment",
					target: {
						kind: "repository",
						host: "github.com",
						owner: "octocat",
						repository: "hello-world",
					},
				},
			],
		})

		session.beginRequest("request-2")
		expect(session.activeRequestLeases()).toEqual([])
		expect(session.review("bash-2", findings)).toEqual({ kind: "ask", findings })
	})
})

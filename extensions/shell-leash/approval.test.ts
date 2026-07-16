import { expect, test } from "bun:test"
import { analyzeResolvedCommand } from "./analyze-command"
import { requestRemoteApproval } from "./approval"

test("interactive approval remains suspended and offers narrow then explicit broad request scopes", async () => {
	const repository = { kind: "repository" as const, host: "github.com", owner: "octocat", repository: "hello-world" }
	const findings = analyzeResolvedCommand({
		argv: ["git", "push", "origin", "main"],
		cwd: "/workspace",
		repository,
	}).findings
	let resolveSelection: ((choice: string) => void) | undefined
	let offered: string[] = []
	let settled = false
	const approval = requestRemoteApproval(findings, async (_prompt, options) => {
		offered = options
		return new Promise<string>((resolve) => {
			resolveSelection = resolve
		})
	})
	approval.then(() => {
		settled = true
	})
	await Promise.resolve()
	await Promise.resolve()
	expect(settled).toBe(false)
	expect(offered).toEqual([
		"Allow once",
		"Allow git.push for github.com/octocat/hello-world via origin this request",
		"Allow git.push for any target this request",
		"Deny",
	])
	resolveSelection?.(offered[1] ?? "Deny")
	expect(await approval).toMatchObject({
		kind: "allow-request",
		grants: [{ scope: { kind: "git-push-target", remote: { kind: "named", name: "origin" } } }],
	})
})

test("a multi-effect approval can add selected request leases without hiding the whole union", async () => {
	const repository = { kind: "repository" as const, host: "github.com", owner: "octocat", repository: "hello-world" }
	const findings = [
		...analyzeResolvedCommand({ argv: ["git", "push", "origin", "main"], cwd: "/workspace", repository }).findings,
		...analyzeResolvedCommand({
			argv: ["gh", "issue", "comment", "12", "--body", "done"],
			cwd: "/workspace",
			repository,
		}).findings,
	]
	const offered: string[][] = []
	const choices = [
		"Approve this call and select request grants…",
		"Allow git.push for github.com/octocat/hello-world via origin this request",
		"Do not grant gh.issue.comment for this request",
	]
	const approval = await requestRemoteApproval(findings, async (_prompt, options) => {
		offered.push(options)
		return choices.shift()
	})
	expect(offered[0]).toEqual(["Allow once", "Approve this call and select request grants…", "Deny"])
	expect(approval).toMatchObject({
		kind: "allow-request",
		grants: [{ finding: { effect: { operation: "git.push" } }, scope: { kind: "git-push-target" } }],
	})
})

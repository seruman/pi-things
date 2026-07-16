import { describe, expect, test } from "bun:test"
import { analyzeResolvedCommand } from "./analyze-command"
import { analyzeShellCommand } from "./analyze-shell"
import { createInvocationPermit } from "./grants"
import type { InvocationManifest } from "./invocation-manifest"
import { decideShimInvocation } from "./shim-decision"

function manifestFor(argv: readonly string[]): InvocationManifest {
	const effects = analyzeResolvedCommand({ argv, cwd: "/workspace" }).findings.map((finding) => finding.effect)
	return {
		version: 1,
		requestId: "request-1",
		toolCallId: "bash-1",
		createdAt: "2026-07-14T12:00:00.000Z",
		expiresAt: "2099-07-14T12:00:00.000Z",
		realExecutables: { git: "/guarded-fixture/bin/git" },
		observationLog: "/guarded-fixture/events.jsonl",
		permit: createInvocationPermit("bash-1", effects),
		leases: [],
	}
}

describe("decideShimInvocation", () => {
	test("delegates a mutation matching its pre-execution allow-once permit", () => {
		const argv = ["git", "push", "origin", "main"]
		expect(decideShimInvocation(manifestFor(argv), argv, "/workspace")).toEqual({
			kind: "delegate",
			observations: [],
		})
	})

	test("rejects a concrete mutation that static analysis did not permit", () => {
		const argv = ["git", "push", "--force", "origin", "main"]
		const manifest = manifestFor(["git", "status"])
		expect(decideShimInvocation(manifest, argv, "/workspace")).toMatchObject({
			kind: "block",
			operations: ["git.push.force"],
			reason: expect.stringContaining("no pre-execution grant"),
		})
	})

	test("refines an approved dynamic target but not its operation qualifier", async () => {
		const staticAnalysis = await analyzeShellCommand({ source: 'git push "$remote" "$branch"', cwd: "/workspace" })
		const permit = createInvocationPermit(
			"bash-1",
			staticAnalysis.findings.map((finding) => finding.effect),
		)
		const manifest = { ...manifestFor(["git", "status"]), permit }

		expect(decideShimInvocation(manifest, ["git", "push", "origin", "main"], "/workspace").kind).toBe("delegate")
		expect(decideShimInvocation(manifest, ["git", "push", "--force", "origin", "main"], "/workspace").kind).toBe(
			"block",
		)
	})
})

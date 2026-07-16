import { describe, expect, test } from "bun:test"
import { analyzeResolvedCommand } from "./analyze-command"
import { githubOperationIds, githubReadOnlyCommandPaths } from "./github-operations"

describe("GitHub operation registry", () => {
	test("has unique categorical operation IDs", () => {
		const ids = githubOperationIds()
		expect(new Set(ids).size).toBe(ids.length)
		expect(ids.length).toBeGreaterThanOrEqual(80)
	})

	test("classifies every concrete and wildcard mutation registry entry", () => {
		for (const operation of githubOperationIds()) {
			if (operation === "gh.api.write") continue
			const [, group, action] = operation.split(".")
			if (!group || !action) throw new Error(`malformed operation ${operation}`)
			const analysis = analyzeResolvedCommand({
				argv: ["gh", group, action === "mutate" ? "future-mutation" : action],
				cwd: "/workspace",
			})
			expect(analysis.findings[0]?.effect.operation, operation).toBe(operation)
		}
	})

	test("classifies every read-only registry entry without an unknown observation", () => {
		for (const [group, action] of githubReadOnlyCommandPaths()) {
			expect(analyzeResolvedCommand({ argv: ["gh", group, action], cwd: "/workspace" }), `${group} ${action}`).toEqual({
				findings: [],
				observations: [],
			})
		}
	})

	test("classifies a non-PR destructive operation with generic command details", () => {
		const analysis = analyzeResolvedCommand({
			argv: ["gh", "-R", "octocat/hello-world", "release", "delete", "v1.0.0"],
			cwd: "/workspace",
		})
		expect(analysis.findings[0]?.effect).toEqual({
			kind: "github",
			operation: "gh.release.delete",
			target: { kind: "repository", host: "github.com", owner: "octocat", repository: "hello-world" },
			details: { command: { group: "release", action: "delete", arguments: ["v1.0.0"] } },
		})
	})

	test("recognizes read-only paths without observations", () => {
		expect(analyzeResolvedCommand({ argv: ["gh", "release", "verify", "v1.0.0"], cwd: "/workspace" })).toEqual({
			findings: [],
			observations: [],
		})
	})
})

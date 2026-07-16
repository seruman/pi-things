import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { withTestTempDirectoryAsync } from "../pi-safety/test-temp-directory"
import { analyzeShellCommand } from "./analyze-shell"

describe("analyzeShellCommand", () => {
	test("extracts independent Git and GitHub commands from a Bash list", async () => {
		const analysis = await analyzeShellCommand({
			source: "git push origin main && gh pr create --fill",
			cwd: "/workspace",
		})

		expect(analysis.findings.map((finding) => finding.effect.operation)).toEqual(["git.push", "gh.pr.create"])
		expect(analysis.observations).toEqual([])
	})

	test("recursively analyzes a literal nested shell script", async () => {
		const analysis = await analyzeShellCommand({
			source: "env X=1 bash -lc 'git push --force origin main'",
			cwd: "/workspace",
		})

		expect(analysis.findings.map((finding) => finding.effect.operation)).toEqual(["git.push.force"])
	})

	test("records a recursion observation for a statically invoked recursive function", async () => {
		const analysis = await analyzeShellCommand({ source: "recur() { recur; }; recur", cwd: "/workspace" })
		expect(analysis.observations.some((observation) => observation.kind === "recursion-limit")).toBe(true)
	})

	test("does not treat an uncalled function body as executed", async () => {
		const analysis = await analyzeShellCommand({
			source: "deploy() { git push origin main; }",
			cwd: "/workspace",
		})

		expect(analysis.findings).toEqual([])
	})

	test("analyzes a statically invoked function body", async () => {
		const analysis = await analyzeShellCommand({
			source: "deploy() { git push origin main; }; deploy",
			cwd: "/workspace",
		})

		expect(analysis.findings.map((finding) => finding.effect.operation)).toEqual(["git.push"])
		expect(analysis.findings[0]?.evidence.source?.kind).toBe("function")
	})

	test("extracts mutations from condition and loop bodies", async () => {
		const analysis = await analyzeShellCommand({
			source: "if test -n x; then git push origin main; fi; for item in one; do gh issue close 12; done",
			cwd: "/workspace",
		})
		expect(analysis.findings.map((finding) => finding.effect.operation)).toEqual(["git.push", "gh.issue.close"])
	})

	test("analyzes command substitutions only in expanding here-documents", async () => {
		const expanding = await analyzeShellCommand({
			source: "cat <<EOF\n$(git push origin main)\nEOF\n",
			cwd: "/workspace",
		})
		expect(expanding.findings.map((finding) => finding.effect.operation)).toEqual(["git.push"])
		const literal = await analyzeShellCommand({
			source: "cat <<'EOF'\n$(git push origin main)\nEOF\n",
			cwd: "/workspace",
		})
		expect(literal.findings).toEqual([])
	})

	test("extracts mutations from process substitutions", async () => {
		const analysis = await analyzeShellCommand({
			source: "cat <(git push origin main) >(gh pr create --fill)",
			cwd: "/workspace",
		})

		expect(analysis.findings.map((finding) => finding.effect.operation)).toEqual(["git.push", "gh.pr.create"])
		expect(analysis.findings.map((finding) => finding.evidence.source?.kind)).toEqual([
			"process-substitution",
			"process-substitution",
		])
	})

	test("retains findings while recording recoverable malformed shell syntax", async () => {
		const analysis = await analyzeShellCommand({ source: "git push origin main &&", cwd: "/workspace" })
		expect(analysis.findings.map((finding) => finding.effect.operation)).toEqual(["git.push"])
		expect(analysis.observations.some((observation) => observation.kind === "shell-syntax")).toBe(true)
	})

	test("records a dynamic executable instead of flattening it into fake argv", async () => {
		const analysis = await analyzeShellCommand({
			source: 'tool=git; "$tool" push origin main',
			cwd: "/workspace",
		})

		expect(analysis.findings).toEqual([])
		expect(analysis.observations).toContainEqual({
			kind: "dynamic-executable",
			source: '"$tool"',
			startByte: 10,
			endByte: 17,
		})
	})

	test("classifies a known push while retaining dynamic remote and ref arguments", async () => {
		const analysis = await analyzeShellCommand({
			source: 'git push "$remote" "$branch"',
			cwd: "/workspace",
		})

		expect(analysis.findings[0]?.effect).toMatchObject({
			operation: "git.push",
			remote: { kind: "unknown", source: '"$remote"' },
			refspecs: [{ kind: "unknown", source: '"$branch"' }],
		})
		expect(analysis.observations.map((observation) => observation.kind)).toEqual([
			"dynamic-argument",
			"dynamic-argument",
		])
	})

	test("extracts a literal Git argv array from Python -c without executing it", async () => {
		const analysis = await analyzeShellCommand({
			source: `python -c 'import subprocess; subprocess.run(["git", "push", "origin", "main"])'`,
			cwd: "/workspace",
		})

		expect(analysis.findings.map((finding) => finding.effect.operation)).toEqual(["git.push"])
	})

	test("extracts single-quoted literal argv without evaluating Python", async () => {
		const analysis = await analyzeShellCommand({
			source: `python -c "import subprocess; subprocess.run(['git', 'push', 'origin', 'main'])"`,
			cwd: "/workspace",
		})
		expect(analysis.findings.map((finding) => finding.effect.operation)).toEqual(["git.push"])
	})

	test("records an unsupported embedded interpreter without evaluating it", async () => {
		const source = "ruby -e 'system(command)'"
		const analysis = await analyzeShellCommand({ source, cwd: "/workspace" })
		expect(analysis.findings).toEqual([])
		expect(analysis.observations).toContainEqual({
			kind: "embedded-dynamic",
			interpreter: "ruby",
			source: "system(command)",
		})
	})

	test("extracts a literal GitHub argv array from Node -e without executing it", async () => {
		const analysis = await analyzeShellCommand({
			source: `node -e 'require("child_process").spawnSync("gh", ["pr", "create", "--fill"])'`,
			cwd: "/workspace",
		})

		expect(analysis.findings.map((finding) => finding.effect.operation)).toEqual(["gh.pr.create"])
	})

	test("extracts literal child commands from xargs", async () => {
		const analysis = await analyzeShellCommand({
			source: "printf '%s\\n' main | xargs -n 1 git push origin",
			cwd: process.cwd(),
		})
		expect(analysis.findings.map((finding) => finding.effect.operation)).toEqual(["git.push"])
		expect(analysis.findings[0]?.effect).toMatchObject({ refspecs: [{ kind: "unknown", source: "<xargs-input>" }] })
		expect(analysis.observations).toContainEqual({ kind: "dynamic-argument", source: "<xargs-input>", index: 3 })
	})

	test("extracts literal child commands from find -exec and -execdir", async () => {
		for (const operator of ["-exec", "-execdir"]) {
			const analysis = await analyzeShellCommand({
				source: `find . ${operator} gh issue close 123 \\;`,
				cwd: process.cwd(),
			})
			expect(analysis.findings.map((finding) => finding.effect.operation)).toEqual(["gh.issue.close"])
		}
	})

	test("extracts a literal GNU parallel command template", async () => {
		const analysis = await analyzeShellCommand({
			source: "parallel git push origin main ::: one two",
			cwd: process.cwd(),
		})
		expect(analysis.findings.map((finding) => finding.effect.operation)).toEqual(["git.push"])
	})

	test("unwraps env and command prefixes before effect analysis", async () => {
		const analysis = await analyzeShellCommand({
			source: "env CI=1 command git push origin main",
			cwd: "/workspace",
		})

		expect(analysis.findings.map((finding) => finding.effect.operation)).toEqual(["git.push"])
	})

	test("uses literal env and sudo chdir options for repository context", async () => {
		await withTestTempDirectoryAsync("shell-leash-wrapper-chdir-", async (root) => {
			const repository = path.join(root, "repository")
			await mkdir(path.join(repository, ".git"), { recursive: true })
			await writeFile(
				path.join(repository, ".git", "config"),
				'[remote "origin"]\n  url = git@github.com:owner/wrapper-context.git\n',
			)
			for (const source of [
				`env --chdir ${repository} git push origin main`,
				`sudo --chdir ${repository} git push origin main`,
			]) {
				const analysis = await analyzeShellCommand({ source, cwd: root })
				expect(analysis.findings[0]?.effect).toMatchObject({
					repository: { kind: "repository", owner: "owner", repository: "wrapper-context" },
				})
			}
		})
	})

	test("uses literal Git work-tree and git-dir environment state", async () => {
		await withTestTempDirectoryAsync("shell-leash-git-environment-", async (root) => {
			const repository = path.join(root, "repository")
			await mkdir(path.join(repository, ".git"), { recursive: true })
			await writeFile(
				path.join(repository, ".git", "config"),
				'[remote "origin"]\n  url = git@github.com:owner/environment-context.git\n',
			)
			const analyses = await Promise.all([
				...[
					`GIT_WORK_TREE=${repository} git push origin main`,
					`GIT_DIR=${path.join(repository, ".git")} git push origin main`,
					`git --work-tree ${repository} push origin main`,
					`git --git-dir ${path.join(repository, ".git")} push origin main`,
				].map((source) => analyzeShellCommand({ source, cwd: root })),
				analyzeShellCommand({ source: "git push origin main", cwd: root, environment: { GIT_WORK_TREE: repository } }),
			])
			for (const analysis of analyses) {
				expect(analysis.findings[0]?.effect).toMatchObject({
					repository: { kind: "repository", owner: "owner", repository: "environment-context" },
				})
			}
		})
	})

	test.each([
		"sudo -u deploy -- git push origin main",
		"/usr/bin/env CI=1 git push origin main",
		"/usr/bin/time -p git push origin main",
		"nohup git push origin main",
		"exec git push origin main",
		"nice -n 5 git push origin main",
	])("unwraps process prefix: %s", async (source) => {
		const analysis = await analyzeShellCommand({ source, cwd: "/workspace" })
		expect(analysis.findings.map((finding) => finding.effect.operation)).toEqual(["git.push"])
	})

	test("does not audit ordinary dynamic arguments for unrelated commands", async () => {
		const analysis = await analyzeShellCommand({ source: 'printf "%s\\n" "$PATH"', cwd: "/workspace" })
		expect(analysis).toEqual({ findings: [], observations: [] })
	})

	test("keeps destructive push qualifiers when the target is dynamic", async () => {
		const analysis = await analyzeShellCommand({ source: 'git push --mirror "$remote"', cwd: "/workspace" })
		expect(analysis.findings[0]?.effect).toMatchObject({
			operation: "git.push.delete",
			remote: { kind: "unknown", source: '"$remote"' },
			details: { mirror: true },
		})
	})

	test("retains a literal GraphQL mutation operation when field values are dynamic", async () => {
		const analysis = await analyzeShellCommand({
			source:
				'gh api graphql -f query="mutation Close($id: ID!) { closeIssue(input: {id: \\"$id\\"}) { clientMutationId } }"',
			cwd: "/workspace",
		})
		expect(analysis.findings[0]?.effect.operation).toBe("gh.api.write")
	})

	test("records a dynamic GraphQL body without guessing that it mutates", async () => {
		const analysis = await analyzeShellCommand({ source: 'gh api graphql -f query="$query"', cwd: "/workspace" })
		expect(analysis.findings).toEqual([])
		expect(analysis.observations).toContainEqual({ kind: "github-graphql-unknown", source: 'query="$query"' })
	})

	test("records a dynamic GitHub API endpoint while retaining the mutating method", async () => {
		const analysis = await analyzeShellCommand({ source: 'gh api -X POST "$endpoint"', cwd: "/workspace" })
		expect(analysis.findings[0]?.effect.operation).toBe("gh.api.write")
		expect(analysis.observations).toContainEqual({ kind: "dynamic-argument", source: '"$endpoint"', index: 4 })
	})

	test("classifies a GitHub API write with a dynamic field value", async () => {
		const analysis = await analyzeShellCommand({
			source: 'gh api -X POST repos/octocat/hello-world/issues -f title="$title"',
			cwd: "/workspace",
		})
		expect(analysis.findings[0]?.effect).toMatchObject({ operation: "gh.api.write" })
	})

	test("classifies a GitHub mutation even when its body is dynamic", async () => {
		const analysis = await analyzeShellCommand({
			source: 'gh -R octocat/hello-world issue comment 123 --body "$comment"',
			cwd: "/workspace",
		})
		expect(analysis.findings[0]?.effect).toMatchObject({
			operation: "gh.issue.comment",
			target: { owner: "octocat", repository: "hello-world" },
		})
		expect(analysis.observations.map((observation) => observation.kind)).toEqual(["dynamic-argument"])
	})

	test("records a dynamic cd because subsequent repository context is unknown", async () => {
		const analysis = await analyzeShellCommand({ source: 'cd "$repository"; git push origin main', cwd: "/workspace" })
		expect(analysis.observations).toContainEqual({ kind: "dynamic-argument", source: '"$repository"', index: 1 })
	})

	test("tracks literal cd per shell scope using only synthetic repository metadata", async () => {
		await withTestTempDirectoryAsync("shell-leash-shell-cwd-", async (root) => {
			const child = path.join(root, "child")
			await mkdir(path.join(root, ".git"))
			await mkdir(path.join(child, ".git"), { recursive: true })
			await writeFile(path.join(root, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:owner/root.git\n')
			await writeFile(path.join(child, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:owner/child.git\n')

			const analysis = await analyzeShellCommand({
				source: "(cd child; git push origin main); gh issue comment 1 --body done",
				cwd: root,
			})
			expect(analysis.findings.map((finding) => finding.effect)).toMatchObject([
				{ operation: "git.push", repository: { repository: "child" } },
				{ operation: "gh.issue.comment", target: { repository: "root" } },
			])
		})
	})

	test("resolves an implicit push to the current branch pushRemote", async () => {
		await withTestTempDirectoryAsync("shell-leash-implicit-push-", async (root) => {
			await mkdir(path.join(root, ".git"))
			await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/topic\n")
			await writeFile(
				path.join(root, ".git", "config"),
				[
					'[remote "origin"]',
					"  url = git@github.com:owner/origin.git",
					'[remote "fork"]',
					"  url = git@github.com:owner/fork.git",
					'[branch "topic"]',
					"  pushRemote = fork",
				].join("\n"),
			)
			const analysis = await analyzeShellCommand({ source: "git push", cwd: root })
			expect(analysis.findings[0]?.effect).toMatchObject({
				remote: { kind: "implicit" },
				refspecs: [{ kind: "source", source: "topic" }],
				repository: { kind: "repository", owner: "owner", repository: "fork" },
			})
		})
	})

	test("resolves a named Git remote repository from its configured push URL", async () => {
		await withTestTempDirectoryAsync("shell-leash-named-remote-", async (root) => {
			await mkdir(path.join(root, ".git"))
			await writeFile(
				path.join(root, ".git", "config"),
				[
					'[remote "origin"]',
					"  url = git@github.com:owner/origin.git",
					'[remote "fork"]',
					"  pushurl = git@github.com:owner/fork.git",
				].join("\n"),
			)
			const analysis = await analyzeShellCommand({ source: "git push fork main", cwd: root })
			expect(analysis.findings[0]?.effect).toMatchObject({
				remote: { kind: "named", name: "fork" },
				repository: { kind: "repository", owner: "owner", repository: "fork" },
			})
		})
	})

	test("retains Git global context and send-pack classification with dynamic refspecs", async () => {
		await withTestTempDirectoryAsync("shell-leash-dynamic-git-context-", async (root) => {
			const repository = path.join(root, "repository")
			await mkdir(path.join(repository, ".git"), { recursive: true })
			await writeFile(
				path.join(repository, ".git", "config"),
				'[remote "origin"]\n  url = git@github.com:owner/dynamic-context.git\n',
			)
			for (const source of [
				'git -C repository push origin "$branch"',
				'git -C repository send-pack origin "$branch"',
			]) {
				const analysis = await analyzeShellCommand({ source, cwd: root })
				expect(analysis.findings[0]?.effect).toMatchObject({
					operation: "git.push",
					repository: { kind: "repository", owner: "owner", repository: "dynamic-context" },
					refspecs: [{ kind: "unknown", source: '"$branch"' }],
				})
			}
		})
	})

	test("resolves Git -C repository context without executing Git", async () => {
		await withTestTempDirectoryAsync("shell-leash-git-c-", async (root) => {
			const child = path.join(root, "child")
			await mkdir(path.join(child, ".git"), { recursive: true })
			await writeFile(path.join(child, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:owner/child.git\n')
			const analysis = await analyzeShellCommand({ source: "git -C child push origin main", cwd: root })
			expect(analysis.findings[0]?.effect).toMatchObject({
				operation: "git.push",
				repository: { kind: "repository", repository: "child" },
			})
		})
	})

	test.each([
		"GH_REPO=octocat/hello-world gh issue comment 123 --body done",
		"GH_REPO=octocat/hello-world; gh issue comment 123 --body done",
		"export GH_REPO=octocat/hello-world; gh issue comment 123 --body done",
	])("uses literal GH_REPO shell state: %s", async (source) => {
		const analysis = await analyzeShellCommand({ source, cwd: "/workspace" })
		expect(analysis.findings[0]?.effect).toMatchObject({
			operation: "gh.issue.comment",
			target: { kind: "repository", host: "github.com", owner: "octocat", repository: "hello-world" },
		})
	})

	test("uses a literal ambient GH_REPO value", async () => {
		const analysis = await analyzeShellCommand({
			source: "gh issue comment 123 --body done",
			cwd: "/workspace",
			environment: { GH_REPO: "octocat/ambient" },
		})
		expect(analysis.findings[0]?.effect).toMatchObject({
			target: { kind: "repository", owner: "octocat", repository: "ambient" },
		})
	})

	test("keeps GH_REPO assignment state within its subshell", async () => {
		const analysis = await analyzeShellCommand({
			source: "(GH_REPO=octocat/inside; gh issue comment 1 --body done); gh issue comment 2 --body done",
			cwd: "/workspace",
		})
		expect(analysis.findings.map((finding) => finding.effect)).toMatchObject([
			{ target: { kind: "repository", repository: "inside" } },
			{ target: { kind: "unknown" } },
		])
	})

	test("uses synthetic repository metadata as GitHub target scope without executing Git", async () => {
		await withTestTempDirectoryAsync("shell-leash-shell-repository-", async (root) => {
			await mkdir(path.join(root, ".git"))
			await writeFile(
				path.join(root, ".git", "config"),
				'[remote "origin"]\n\turl = git@github.com:octocat/hello-world.git\n',
			)
			const analysis = await analyzeShellCommand({ source: "gh issue comment 123 --body done", cwd: root })

			expect(analysis.findings[0]).toMatchObject({
				effect: {
					operation: "gh.issue.comment",
					target: { kind: "repository", host: "github.com", owner: "octocat", repository: "hello-world" },
				},
				certainty: "exact",
			})
		})
	})
})

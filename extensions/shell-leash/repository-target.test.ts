import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { withTestTempDirectoryAsync } from "../pi-safety/test-temp-directory"
import { parseRepositoryUrl, resolveRepositoryContext, resolveRepositoryTarget } from "./repository-target"

describe("resolveRepositoryTarget", () => {
	test("normalizes SCP, SSH, HTTPS, and enterprise repository URLs", () => {
		expect(parseRepositoryUrl("git@github.com:owner/repository.git")).toEqual({
			kind: "repository",
			host: "github.com",
			owner: "owner",
			repository: "repository",
		})
		expect(parseRepositoryUrl("ssh://git@github.com/owner/repository.git")).toEqual({
			kind: "repository",
			host: "github.com",
			owner: "owner",
			repository: "repository",
		})
		expect(parseRepositoryUrl("https://github.example.test/owner/repository.git")).toEqual({
			kind: "repository",
			host: "github.example.test",
			owner: "owner",
			repository: "repository",
		})
	})
	test("reads a synthetic Git config without executing Git", async () => {
		await withTestTempDirectoryAsync("shell-leash-repository-", async (root) => {
			const cwd = path.join(root, "project", "packages", "app")
			await mkdir(path.join(root, "project", ".git"), { recursive: true })
			await mkdir(cwd, { recursive: true })
			await writeFile(
				path.join(root, "project", ".git", "config"),
				'[remote "origin"]\n\turl = git@github.com:octocat/hello-world.git\n',
			)

			expect(await resolveRepositoryTarget(cwd)).toEqual({
				ok: true,
				value: { kind: "repository", host: "github.com", owner: "octocat", repository: "hello-world" },
			})
		})
	})

	test("uses current branch pushRemote for an implicit push", async () => {
		await withTestTempDirectoryAsync("shell-leash-upstream-", async (root) => {
			await mkdir(path.join(root, ".git"))
			await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/topic\n")
			await writeFile(
				path.join(root, ".git", "config"),
				[
					'[remote "origin"]',
					"  url = git@github.com:owner/origin.git",
					'[remote "fork"]',
					"  pushurl = git@github.com:owner/fork.git",
					'[branch "topic"]',
					"  remote = origin",
					"  pushRemote = fork",
				].join("\n"),
			)
			const context = await resolveRepositoryContext(root)
			expect(context).toMatchObject({
				ok: true,
				value: {
					currentBranch: "topic",
					defaultPushRemote: "fork",
					repository: { kind: "repository", owner: "owner", repository: "fork" },
				},
			})
		})
	})

	test("resolves linked-worktree config and HEAD through commondir", async () => {
		await withTestTempDirectoryAsync("shell-leash-linked-worktree-", async (root) => {
			const worktree = path.join(root, "worktree")
			const common = path.join(root, "main", ".git")
			const worktreeGit = path.join(common, "worktrees", "topic")
			await mkdir(worktree, { recursive: true })
			await mkdir(worktreeGit, { recursive: true })
			await writeFile(path.join(worktree, ".git"), `gitdir: ${worktreeGit}\n`)
			await writeFile(path.join(worktreeGit, "commondir"), "../..\n")
			await writeFile(path.join(worktreeGit, "HEAD"), "ref: refs/heads/topic\n")
			await writeFile(path.join(common, "config"), '[remote "origin"]\n  url = git@github.com:owner/linked.git\n')
			expect(await resolveRepositoryContext(worktree)).toMatchObject({
				ok: true,
				value: {
					currentBranch: "topic",
					repository: { kind: "repository", owner: "owner", repository: "linked" },
				},
			})
		})
	})

	test("collects every named remote and prefers pushurl", async () => {
		await withTestTempDirectoryAsync("shell-leash-remotes-", async (root) => {
			await mkdir(path.join(root, ".git"))
			await writeFile(
				path.join(root, ".git", "config"),
				[
					'[remote "origin"]',
					"  url = git@github.com:octocat/origin.git",
					'[remote "fork"]',
					"  url = git@github.com:octocat/fetch-fork.git",
					"  pushurl = git@github.com:octocat/push-fork.git",
				].join("\n"),
			)
			const context = await resolveRepositoryContext(root)
			expect(context.ok && Object.fromEntries(context.value.remotes)).toEqual({
				origin: "git@github.com:octocat/origin.git",
				fork: "git@github.com:octocat/push-fork.git",
			})
		})
	})
})

import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import * as path from "node:path"
import { withTestTempDirectoryAsync } from "../pi-safety/test-temp-directory"
import { analyzeShellCommand } from "./analyze-shell"
import { createInvocationPermit, createRequestLease } from "./grants"
import type { InvocationManifest } from "./invocation-manifest"
import { runShim } from "./shim-runner"
import { assertFixtureExecutable, writeDenyNetworkFixtureExecutable } from "./test-process"

const MANIFEST_LIFETIME = {
	createdAt: "2026-07-14T12:00:00.000Z",
	expiresAt: "2099-07-14T12:00:00.000Z",
} as const

describe("runShim", () => {
	test("delegates read-only Git and GitHub argv only to nonce-guarded fixture executables", async () => {
		await withTestTempDirectoryAsync("shell-leash-shim-", async (root) => {
			const executable = await writeDenyNetworkFixtureExecutable(
				root,
				"git",
				`[ "$SHELL_LEASH_TEST_NONCE" = "nonce-1" ] || exit 97
network_result=$(/usr/bin/python3 -c 'import socket; s=socket.socket(); print(s.connect_ex(("127.0.0.1", 9)))')
[ "$network_result" = "1" ] || { printf 'unexpected network result: %s\\n' "$network_result" >&2; exit 98; }
printf '%s\\n' "$@"\n`,
			)
			const ghExecutable = await writeDenyNetworkFixtureExecutable(
				root,
				"gh",
				`[ "$SHELL_LEASH_TEST_NONCE" = "nonce-1" ] || exit 97
printf '%s\\n' "$@"\n`,
			)
			assertFixtureExecutable(root, executable)
			assertFixtureExecutable(root, ghExecutable)
			const manifest: InvocationManifest = {
				version: 1,
				...MANIFEST_LIFETIME,
				requestId: "request-1",
				toolCallId: "bash-1",
				realExecutables: { git: executable, gh: ghExecutable },
				observationLog: path.join(root, "events.jsonl"),
				permit: createInvocationPermit("bash-1", []),
				leases: [],
			}

			for (const [argv, stdout] of [
				[["git", "--version"], "--version\n"],
				[["git", "status", "--short"], "status\n--short\n"],
				[["gh", "--version"], "--version\n"],
			] as const) {
				const result = await runShim(manifest, argv, {
					cwd: root,
					env: { PATH: "", SHELL_LEASH_TEST_NONCE: "nonce-1" },
					captureOutput: true,
					fixtureRoot: root,
				})
				expect(result).toEqual({
					kind: "delegated",
					exitCode: 0,
					stdout,
					stderr: "",
					observations: [],
				})
			}
		})
	})

	test("delegates a matching request lease through the network-denied fixture", async () => {
		await withTestTempDirectoryAsync("shell-leash-shim-lease-", async (root) => {
			await Bun.write(path.join(root, ".git", "config"), '[remote "origin"]\n  url = git@github.com:owner/repo.git\n')
			const executable = await writeDenyNetworkFixtureExecutable(
				root,
				"git",
				`network_result=$(/usr/bin/python3 -c 'import socket; s=socket.socket(); print(s.connect_ex(("127.0.0.1", 9)))')
[ "$network_result" = "1" ] || { printf 'unexpected network result: %s\\n' "$network_result" >&2; exit 98; }
printf '%s\\n' "$@"
`,
			)
			const repository = { kind: "repository" as const, host: "github.com", owner: "owner", repository: "repo" }
			const manifest: InvocationManifest = {
				version: 1,
				...MANIFEST_LIFETIME,
				requestId: "request-1",
				toolCallId: "bash-1",
				realExecutables: { git: executable },
				observationLog: path.join(root, "events.jsonl"),
				permit: createInvocationPermit("bash-1", []),
				leases: [
					createRequestLease("request-1", "git.push", {
						kind: "git-push-target",
						repository,
						remote: { kind: "named", name: "origin" },
					}),
				],
			}
			const result = await runShim(manifest, ["git", "push", "origin", "main"], {
				cwd: root,
				env: { PATH: "" },
				captureOutput: true,
				fixtureRoot: root,
			})
			expect(result).toMatchObject({ kind: "delegated", exitCode: 0, stdout: "push\norigin\nmain\n" })
		})
	})

	test("uses Git -C context when refining a static permit", async () => {
		await withTestTempDirectoryAsync("shell-leash-shim-git-c-", async (root) => {
			const child = path.join(root, "child")
			await Bun.write(path.join(child, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:owner/child.git\n')
			const executable = await writeDenyNetworkFixtureExecutable(
				root,
				"git",
				`[ "$SHELL_LEASH_TEST_NONCE" = "nonce-c" ] || exit 97\nprintf '%s\\n' "$@"\n`,
			)
			const analysis = await analyzeShellCommand({ source: "git -C child push origin main", cwd: root })
			const manifest: InvocationManifest = {
				version: 1,
				...MANIFEST_LIFETIME,
				requestId: "request-1",
				toolCallId: "bash-1",
				realExecutables: { git: executable },
				observationLog: path.join(root, "events.jsonl"),
				permit: createInvocationPermit(
					"bash-1",
					analysis.findings.map((finding) => finding.effect),
				),
				leases: [],
			}
			const result = await runShim(manifest, ["git", "-C", "child", "push", "origin", "main"], {
				cwd: root,
				env: { PATH: "", SHELL_LEASH_TEST_NONCE: "nonce-c" },
				captureOutput: true,
				fixtureRoot: root,
			})
			expect(result).toMatchObject({ kind: "delegated", exitCode: 0 })
		})
	})

	test("preserves stdin, stdout, stderr, CWD, environment, exit status, and canonical executable selection", async () => {
		await withTestTempDirectoryAsync("shell-leash-shim-io-", async (root) => {
			const executable = await writeDenyNetworkFixtureExecutable(
				root,
				"real-git",
				'read input\nprintf "stdout:%s:%s:%s\\n" "$input" "$PWD" "$FIXTURE_ENV"\nprintf "stderr:%s\\n" "$input" >&2\nexit 23\n',
			)
			const pathTrap = path.join(root, "path-trap")
			await mkdir(pathTrap)
			await Bun.write(path.join(pathTrap, "git"), "#!/bin/sh\nexit 99\n")
			const manifest: InvocationManifest = {
				version: 1,
				...MANIFEST_LIFETIME,
				requestId: "request-1",
				toolCallId: "bash-1",
				realExecutables: { git: executable },
				observationLog: path.join(root, "events.jsonl"),
				permit: createInvocationPermit("bash-1", []),
				leases: [],
			}
			const result = await runShim(manifest, ["git", "status"], {
				cwd: root,
				env: { PATH: pathTrap, FIXTURE_ENV: "preserved" },
				captureOutput: true,
				fixtureRoot: root,
				stdin: "hello\n",
			})
			expect(result).toEqual({
				kind: "delegated",
				exitCode: 23,
				stdout: `stdout:hello:${root}:preserved\n`,
				stderr: "stderr:hello\n",
				observations: [],
			})
		})
	})

	test("uses runtime GH_REPO when refining an approved GitHub mutation", async () => {
		await withTestTempDirectoryAsync("shell-leash-shim-gh-repo-", async (root) => {
			const executable = await writeDenyNetworkFixtureExecutable(
				root,
				"gh",
				`[ "$SHELL_LEASH_TEST_NONCE" = "nonce-gh" ] || exit 97\nprintf '%s\\n' "$@"\n`,
			)
			const analysis = await analyzeShellCommand({
				source: "GH_REPO=octocat/hello-world gh issue comment 123 --body done",
				cwd: root,
			})
			const manifest: InvocationManifest = {
				version: 1,
				...MANIFEST_LIFETIME,
				requestId: "request-1",
				toolCallId: "bash-1",
				realExecutables: { git: executable, gh: executable },
				observationLog: path.join(root, "events.jsonl"),
				permit: createInvocationPermit(
					"bash-1",
					analysis.findings.map((finding) => finding.effect),
				),
				leases: [],
			}
			const result = await runShim(manifest, ["gh", "issue", "comment", "123", "--body", "done"], {
				cwd: root,
				env: { PATH: "", GH_REPO: "octocat/hello-world", SHELL_LEASH_TEST_NONCE: "nonce-gh" },
				captureOutput: true,
				fixtureRoot: root,
			})
			expect(result).toMatchObject({ kind: "delegated", exitCode: 0 })
		})
	})

	test("reports a delegated fixture signal with its conventional exit status", async () => {
		await withTestTempDirectoryAsync("shell-leash-shim-signal-", async (root) => {
			const executable = await writeDenyNetworkFixtureExecutable(root, "git", "kill -TERM $$\n")
			const manifest: InvocationManifest = {
				version: 1,
				...MANIFEST_LIFETIME,
				requestId: "request-1",
				toolCallId: "bash-1",
				realExecutables: { git: executable },
				observationLog: path.join(root, "events.jsonl"),
				permit: createInvocationPermit("bash-1", []),
				leases: [],
			}
			const result = await runShim(manifest, ["git", "status"], {
				cwd: root,
				env: { PATH: "" },
				captureOutput: true,
				fixtureRoot: root,
			})
			expect(result).toMatchObject({ kind: "delegated", exitCode: 143, signal: "SIGTERM" })
		})
	})

	test("test capture mode rejects a real executable path before spawning", async () => {
		await withTestTempDirectoryAsync("shell-leash-shim-real-path-", async (root) => {
			const manifest: InvocationManifest = {
				version: 1,
				...MANIFEST_LIFETIME,
				requestId: "request-1",
				toolCallId: "bash-1",
				realExecutables: { git: "/usr/bin/git" },
				observationLog: path.join(root, "events.jsonl"),
				permit: createInvocationPermit("bash-1", []),
				leases: [],
			}
			const result = await runShim(manifest, ["git", "status"], {
				cwd: root,
				env: { PATH: "" },
				captureOutput: true,
				fixtureRoot: root,
			})
			expect(result).toMatchObject({ kind: "blocked", stderr: expect.stringContaining("outside guarded fixture root") })
		})
	})

	test("concurrent manifests do not cross-authorize sibling Bash calls", async () => {
		await withTestTempDirectoryAsync("shell-leash-shim-concurrent-", async (root) => {
			const executable = await writeDenyNetworkFixtureExecutable(root, "git", "printf 'delegated\\n'\n")
			const ordinary = await analyzeShellCommand({ source: "git push origin main", cwd: root })
			const forced = await analyzeShellCommand({ source: "git push --force origin main", cwd: root })
			const manifest = (toolCallId: string, effects: typeof ordinary.findings): InvocationManifest => ({
				version: 1,
				...MANIFEST_LIFETIME,
				requestId: "request-1",
				toolCallId,
				realExecutables: { git: executable },
				observationLog: path.join(root, `${toolCallId}.jsonl`),
				permit: createInvocationPermit(
					toolCallId,
					effects.map((finding) => finding.effect),
				),
				leases: [],
			})
			const options = { cwd: root, env: { PATH: "" }, captureOutput: true as const, fixtureRoot: root }
			const [blocked, delegated] = await Promise.all([
				runShim(manifest("bash-ordinary", ordinary.findings), ["git", "push", "--force", "origin", "main"], options),
				runShim(manifest("bash-force", forced.findings), ["git", "push", "--force", "origin", "main"], options),
			])
			expect(blocked.kind).toBe("blocked")
			expect(delegated).toMatchObject({ kind: "delegated", stdout: "delegated\n" })
		})
	})

	test("does not start the fixture executable for an ungranted mutation", async () => {
		await withTestTempDirectoryAsync("shell-leash-shim-block-", async (root) => {
			const marker = path.join(root, "executed")
			const executable = await writeDenyNetworkFixtureExecutable(root, "git", `printf executed > '${marker}'\n`)
			assertFixtureExecutable(root, executable)
			const manifest: InvocationManifest = {
				version: 1,
				...MANIFEST_LIFETIME,
				requestId: "request-1",
				toolCallId: "bash-1",
				realExecutables: { git: executable },
				observationLog: path.join(root, "events.jsonl"),
				permit: createInvocationPermit("bash-1", []),
				leases: [],
			}

			const result = await runShim(manifest, ["git", "push", "--force", "origin", "main"], {
				cwd: root,
				env: { PATH: "" },
				captureOutput: true,
				fixtureRoot: root,
			})
			expect(result.kind).toBe("blocked")
			expect(await Bun.file(marker).exists()).toBe(false)
		})
	})
})

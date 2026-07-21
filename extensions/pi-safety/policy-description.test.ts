import { expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { createDefaultPolicy } from "./default-policy"
import { allowRuntimeOperations, noAccess, shared, tree } from "./policy"
import { describePolicy } from "./policy-description"
import { unwrap } from "./result"
import { canonicalExecutable, canonicalPath, testPolicy } from "./test-domain-values"
import { withTestTempDirectory } from "./test-temp-directory"

test("describes every rule in a fully integrated default policy", () => {
	withTestTempDirectory("policy-description-default-", (root) => {
		const workspace = path.join(root, "workspace")
		const home = path.join(root, "home")
		const stateHome = path.join(root, "state")
		const piConfigDirectory = path.join(root, "pi-agent")
		const privateTemp = path.join(root, "tmp")
		const wbRuntime = path.join(root, "wb-runtime")
		const webKitState = path.join(home, "Library", "WebKit", "wb")
		const cacheState = path.join(home, "Library", "Caches", "wb")
		for (const directory of [
			workspace,
			home,
			stateHome,
			piConfigDirectory,
			privateTemp,
			wbRuntime,
			webKitState,
			cacheState,
		]) {
			fs.mkdirSync(directory, { recursive: true })
		}
		const policy = unwrap(
			createDefaultPolicy({
				paths: {
					workspace: canonicalPath(workspace),
					home: canonicalPath(home),
					stateHome: canonicalPath(stateHome),
					piConfigDirectory: canonicalPath(piConfigDirectory),
				},
				additionalNoAccessPatterns: ["secrets/**"],
				sandbox: {
					kind: "enabled",
					privateTemp: canonicalPath(privateTemp),
					integrations: {
						gitExecutable: canonicalExecutable("/usr/bin/git"),
						nix: { kind: "disabled" },
						sshAgent: { kind: "unix-socket", socket: canonicalPath(path.join(root, "ssh.sock")) },
						docker: { kind: "unix-socket", socket: canonicalPath(path.join(root, "docker.sock")) },
						wb: {
							kind: "enabled",
							executable: canonicalExecutable("/bin/bash"),
							runtimeDirectory: canonicalPath(wbRuntime),
							socket: canonicalPath(path.join(wbRuntime, "wb.sock")),
							log: canonicalPath(path.join(wbRuntime, "wb.log")),
							webKitState: canonicalPath(webKitState),
							cacheState: canonicalPath(cacheState),
						},
					},
				},
			}),
		)

		const description = describePolicy(policy)
		const lines = description.split("\n")
		expect(lines).toHaveLength(policy.rules.length + 4)
		for (const [index] of policy.rules.entries()) {
			expect(lines[index + 4]?.startsWith(String(index + 1).padStart(3, "0"))).toBe(true)
		}
		for (const fragment of [
			"file shared none glob=",
			"file sandbox read-write seatbelt-file=",
			'file executable="/usr/bin/git" read-write tree=',
			"snapshot exclude glob=",
			"runtime operations allow",
			"runtime same-sandbox allow",
			"runtime file allow",
			"runtime network-outbound allow endpoint=remote",
			"runtime network-outbound allow path=",
			"runtime mach-lookup allow",
			"runtime ipc-posix-shm-read-data allow",
			"runtime unix-connect allow",
			"runtime unix-bind deny",
			"runtime file-extension allow",
			"runtime broker-extension allow",
		]) {
			expect(description).toContain(fragment)
		}
	})
})

test("describes the complete policy in evaluation order", () => {
	const policy = testPolicy("/", "/", {
		additionalRules: [
			noAccess(shared(), tree(canonicalPath("/private"))),
			allowRuntimeOperations(["process-exec", "process-fork"]),
		],
	})

	expect(describePolicy(policy)).toBe(
		[
			"Pi Safety policy (ordered; file and snapshot rules are last-match-wins)",
			'workspace "/"',
			'home      "/"',
			"",
			'001 file shared read-only tree="/"',
			'002 file shared read-write tree="/"',
			'003 file shared none tree="/private"',
			"004 runtime operations allow [process-exec, process-fork]",
		].join("\n"),
	)
})

import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { createDefaultFilePolicy, createSnapshotFilePolicy, defaultRuntimeRules } from "./default-rules"
import { decideFileAccess, decideSnapshotDisposition } from "./file-policy"
import { unwrap } from "./result"
import { emitSbplProfile } from "./sbpl"
import { canonicalExecutable, canonicalPath } from "./test-domain-values"
import { withTestTempDirectory } from "./test-temp-directory"

test("default effect rules drive access and snapshots independently", () => {
	withTestTempDirectory("default-rules-", (root) => {
		const workspace = path.join(root, "workspace")
		const home = path.join(root, "home")
		const stateHome = path.join(root, "state")
		const piConfigDirectory = path.join(root, "pi-agent")
		for (const directory of [workspace, home, stateHome, piConfigDirectory]) {
			fs.mkdirSync(directory, { recursive: true })
		}
		const workspaceRoot = canonicalPath(workspace)
		const policy = unwrap(
			createDefaultFilePolicy({
				paths: {
					workspace: workspaceRoot,
					home: canonicalPath(home),
					stateHome: canonicalPath(stateHome),
					piConfigDirectory: canonicalPath(piConfigDirectory),
				},
				additionalNoAccessPatterns: ["private/**"],
			}),
		)

		assert.equal(decideFileAccess(policy, canonicalPath(path.join(workspace, "src", "index.ts"))).value, "read-write")
		assert.equal(decideFileAccess(policy, canonicalPath(path.join(workspace, ".mcp.json"))).value, "read-only")
		assert.equal(decideFileAccess(policy, canonicalPath(path.join(workspace, ".env.local"))).value, "none")
		assert.equal(decideFileAccess(policy, canonicalPath(path.join(workspace, "private", "token"))).value, "none")
		assert.equal(
			decideSnapshotDisposition(policy, canonicalPath(path.join(workspace, "nested", "node_modules", "pkg.js"))).value,
			"exclude",
		)
		assert.equal(decideSnapshotDisposition(policy, canonicalPath(path.join(workspace, ".env.local"))).value, "include")
	})
})

test("snapshot-only policy uses the same default exclusion declarations", () => {
	const workspace = canonicalPath("/tmp/pi-safety-default-snapshot-policy")
	const policy = unwrap(createSnapshotFilePolicy(workspace))
	assert.equal(
		decideSnapshotDisposition(policy, canonicalPath(path.join(workspace, "reference", "dist", "bundle.js"))).value,
		"exclude",
	)
	assert.equal(decideFileAccess(policy, canonicalPath(path.join(workspace, "README.md"))).value, "read-write")
})

test("runtime socket adapters use exact grants and broad wb denials", () => {
	const root = canonicalPath("/")
	const sshSocket = canonicalPath("/tmp/pi-safety-ssh.sock")
	const dockerSocket = canonicalPath("/tmp/pi-safety-docker.sock")
	const wbSocket = canonicalPath("/tmp/pi-safety-wb/wb.sock")
	const policy = unwrap(createSnapshotFilePolicy(canonicalPath("/tmp/pi-safety-default-socket-policy")))
	const compiled = emitSbplProfile(
		defaultRuntimeRules({
			policy,
			integrations: {
				gitExecutable: canonicalExecutable("/usr/bin/git"),
				sshAgent: { kind: "unix-socket", socket: sshSocket },
				docker: { kind: "unix-socket", socket: dockerSocket },
				wb: {
					kind: "enabled",
					executable: canonicalExecutable("/usr/bin/true"),
					runtimeDirectory: canonicalPath("/tmp/pi-safety-wb"),
					socket: wbSocket,
					log: canonicalPath("/tmp/pi-safety-wb/wb.log"),
					webKitState: canonicalPath("/tmp/pi-safety-webkit"),
					cacheState: canonicalPath("/tmp/pi-safety-cache"),
				},
			},
		}),
	)
	const reference = (value: string): string => {
		const parameter = compiled.parameters.find((candidate) => candidate.value === value)
		assert.ok(parameter, `missing parameter for ${value}`)
		return `(param "${parameter.name}")`
	}

	for (const socket of [sshSocket, dockerSocket, wbSocket]) {
		assert.ok(compiled.source.includes(`(remote unix-socket (path ${reference(socket)}))`))
	}
	assert.ok(compiled.source.includes(`(allow network-bind\n    (local unix-socket (path ${reference(wbSocket)}))`))
	assert.ok(compiled.source.includes(`(deny network-outbound\n    (remote unix-socket (subpath ${reference(root)}))`))
	assert.ok(compiled.source.includes(`(deny network-bind\n    (local unix-socket (subpath ${reference(root)}))`))
})

test("default runtime permissions are emitted entirely through the typed SBPL DSL", () => {
	const policy = unwrap(createSnapshotFilePolicy(canonicalPath("/tmp/pi-safety-default-runtime-policy")))
	const compiled = emitSbplProfile(
		defaultRuntimeRules({
			policy,
			integrations: {
				gitExecutable: canonicalExecutable("/usr/bin/git"),
				sshAgent: { kind: "disabled" },
				docker: { kind: "disabled" },
				wb: { kind: "disabled" },
			},
		}),
	)
	assert.match(compiled.source, /^\(version 1\)\n\(deny default\)/)
	assert.match(compiled.source, /allow process-exec process-fork/)
	assert.match(compiled.source, /allow network-outbound/)
	assert.ok(compiled.parameters.some((parameter) => parameter.value === "com.apple.system.notification_center"))
})

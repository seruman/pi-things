import { test } from "bun:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { createDefaultPolicy } from "./default-policy"
import type { BashIntegrations } from "./integrations"
import { unwrap } from "./result"
import { emitSeatbelt } from "./seatbelt"
import { canonicalExecutable, canonicalPath } from "./test-domain-values"
import { runWithSeatbeltProfile } from "./test-seatbelt"
import { withPrivateTmpDirectory } from "./test-temp-directory"

function compilePolicy(
	root: string,
	workspace: string,
	home: string,
	privateTemp: string,
	integrations: BashIntegrations,
) {
	const stateHome = path.join(root, "state")
	const piConfigDirectory = path.join(root, "pi-agent")
	for (const directory of [stateHome, piConfigDirectory]) fs.mkdirSync(directory)
	return emitSeatbelt(
		unwrap(
			createDefaultPolicy({
				paths: {
					workspace: canonicalPath(workspace),
					home: canonicalPath(home),
					stateHome: canonicalPath(stateHome),
					piConfigDirectory: canonicalPath(piConfigDirectory),
				},
				additionalNoAccessPatterns: [],
				sandbox: { kind: "enabled", privateTemp: canonicalPath(privateTemp), integrations },
			}),
		),
	)
}

test("explicit Docker Unix socket capability permits only the discovered endpoint", () => {
	withPrivateTmpDirectory("pi-safety-docker-socket-", (root) => {
		const workspace = path.join(root, "workspace")
		const home = path.join(root, "home")
		const privateTemp = path.join(root, "tmp")
		const socket = path.join(root, "docker.sock")
		for (const directory of [workspace, home, privateTemp]) fs.mkdirSync(directory)
		const server = Bun.spawn([
			"/usr/bin/python3",
			"-c",
			"import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(1); c,_=s.accept(); c.close()",
			socket,
		])
		try {
			const deadline = Date.now() + 5_000
			while (!fs.existsSync(socket)) {
				if (Date.now() >= deadline) throw new Error("temporary Docker socket server did not start")
				Bun.sleepSync(10)
			}
			const integrations = {
				gitExecutable: canonicalExecutable("/usr/bin/git"),
				sshAgent: { kind: "disabled" },
				docker: { kind: "unix-socket", socket: canonicalPath(socket) },
				wb: { kind: "disabled" },
			} as const
			const compiled = compilePolicy(root, workspace, home, privateTemp, integrations)
			const script = "import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.close()"
			const result = runWithSeatbeltProfile(compiled, "/usr/bin/python3", ["-c", script, socket], workspace)
			assert.equal(result.status, 0, result.stderr)
		} finally {
			server.kill()
		}
	})
})

test("explicit SSH agent socket capability permits agent use without private-key reads", () => {
	withPrivateTmpDirectory("pi-safety-ssh-agent-", (root) => {
		const workspace = path.join(root, "workspace")
		const home = path.join(root, "home")
		const privateTemp = path.join(root, "tmp")
		const socket = path.join(root, "agent.sock")
		for (const directory of [workspace, home, privateTemp]) fs.mkdirSync(directory)
		const started = spawnSync("/usr/bin/ssh-agent", ["-a", socket, "-s"], { encoding: "utf8" })
		assert.equal(started.status, 0, started.stderr)
		const pidMatch = /SSH_AGENT_PID=(\d+)/.exec(started.stdout)
		if (!pidMatch) throw new Error(`could not parse test ssh-agent pid: ${started.stdout}`)
		const agentPid = Number(pidMatch[1])
		try {
			const integrations = {
				gitExecutable: canonicalExecutable("/usr/bin/git"),
				sshAgent: { kind: "unix-socket", socket: canonicalPath(socket) },
				docker: { kind: "disabled" },
				wb: { kind: "disabled" },
			} as const
			const compiled = compilePolicy(root, workspace, home, privateTemp, integrations)
			const result = runWithSeatbeltProfile(compiled, "/usr/bin/ssh-add", ["-l"], workspace, {
				...process.env,
				SSH_AUTH_SOCK: socket,
			})
			assert.equal(result.status, 1, result.stderr)
			assert.match(`${result.stdout}${result.stderr}`, /no identities/)
		} finally {
			process.kill(agentPid, "SIGTERM")
		}
	})
})

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
import { assertDenied, runWithSeatbeltProfile } from "./test-seatbelt"
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
				nix: { kind: "disabled" },
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

test("Nix receives only its cache and exact daemon socket capabilities", () => {
	withPrivateTmpDirectory("pi-safety-nix-socket-", (root) => {
		const workspace = path.join(root, "workspace")
		const home = path.join(root, "home")
		const privateTemp = path.join(root, "tmp")
		const cacheDirectory = path.join(home, ".cache", "nix")
		const nixExecutable = "/usr/bin/perl"
		const socket = path.join(root, "nix-daemon.sock")
		for (const directory of [workspace, home, privateTemp, cacheDirectory]) fs.mkdirSync(directory, { recursive: true })
		const server = Bun.spawn([
			"/usr/bin/python3",
			"-c",
			"import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(5);\nwhile True:\n c,_=s.accept(); c.close()",
			socket,
		])
		try {
			const deadline = Date.now() + 5_000
			while (!fs.existsSync(socket)) {
				if (Date.now() >= deadline) throw new Error("temporary Nix socket server did not start")
				Bun.sleepSync(10)
			}
			if (server.exitCode !== null) throw new Error(`temporary Nix socket server exited ${server.exitCode}`)
			const integrations = {
				gitExecutable: canonicalExecutable("/usr/bin/git"),
				nix: {
					kind: "enabled",
					executable: canonicalExecutable(nixExecutable),
					cacheDirectory: canonicalPath(cacheDirectory),
					daemon: { kind: "unix-socket", socket: canonicalPath(socket) },
				},
				sshAgent: { kind: "disabled" },
				docker: { kind: "disabled" },
				wb: { kind: "disabled" },
			} as const
			const compiled = compilePolicy(root, workspace, home, privateTemp, integrations)
			const cacheResult = runWithSeatbeltProfile(
				compiled,
				nixExecutable,
				["-e", 'open my $file, ">", $ARGV[0] or die $!; close $file', path.join(cacheDirectory, "fetcher.lock")],
				workspace,
			)
			assert.equal(cacheResult.status, 0, cacheResult.stderr)
			assertDenied(
				runWithSeatbeltProfile(
					compiled,
					"/bin/bash",
					["-c", `printf denied > ${JSON.stringify(path.join(cacheDirectory, "other-process"))}`],
					workspace,
				),
			)
			const socketScript = "my $socket = IO::Socket::UNIX->new(Peer => $ARGV[0]) or die $!; close $socket"
			const socketResult = runWithSeatbeltProfile(
				compiled,
				nixExecutable,
				["-MIO::Socket::UNIX", "-e", socketScript, socket],
				workspace,
			)
			assert.equal(socketResult.status, 0, socketResult.stderr)
			assertDenied(
				runWithSeatbeltProfile(
					compiled,
					"/usr/bin/python3",
					["-c", "import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.close()", socket],
					workspace,
				),
			)
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
				nix: { kind: "disabled" },
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

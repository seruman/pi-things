import { test } from "bun:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { cleanupBashIntegrations, parseBashIntegrations, prepareBashIntegrations } from "./integrations"
import { canonicalExecutable, canonicalPath } from "./test-domain-values"
import { withTestTempDirectory } from "./test-temp-directory"

test("parses SSH agent, Docker, and native wb integrations into closed variants", () => {
	withTestTempDirectory("integrations-", (root) => {
		const home = path.join(root, "home")
		const temp = path.join(root, "tmp")
		const bin = path.join(root, "bin")
		const sshSocket = path.join(temp, "ssh.sock")
		const dockerSocket = path.join(temp, "docker.sock")
		for (const directory of [home, temp, bin]) fs.mkdirSync(directory)
		const wb = path.join(bin, "wb")
		const nix = path.join(bin, "nix")
		fs.writeFileSync(wb, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
		fs.writeFileSync(nix, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
		const installedGit = Bun.which("git")
		if (!installedGit) throw new Error("Git must be installed for integration tests")
		fs.symlinkSync(installedGit, path.join(bin, "git"))

		const input = {
			environment: {
				path: bin,
				sshAuthSock: sshSocket,
				dockerHost: `unix://${dockerSocket}`,
				dockerContext: undefined,
			},
			home: canonicalPath(home),
		}
		const parsed = parseBashIntegrations(input)
		assert.equal(parsed.ok, true, parsed.ok ? undefined : JSON.stringify(parsed.error))
		if (!parsed.ok) return
		assert.equal(parsed.value.gitExecutable, canonicalExecutable(installedGit))
		assert.deepEqual(parsed.value.nix, {
			kind: "enabled",
			executable: canonicalExecutable(nix),
			cacheDirectory: canonicalPath(path.join(home, ".cache", "nix")),
			daemon: { kind: "unix-socket", socket: canonicalPath("/nix/var/nix/daemon-socket/socket") },
		})
		assert.deepEqual(parsed.value.sshAgent, { kind: "unix-socket", socket: canonicalPath(sshSocket) })
		assert.deepEqual(parsed.value.docker, { kind: "unix-socket", socket: canonicalPath(dockerSocket) })
		assert.equal(parsed.value.wb.kind, "enabled")
		if (parsed.value.wb.kind === "enabled") {
			assert.equal(parsed.value.wb.executable, canonicalPath(wb))
			const nextGeneration = parseBashIntegrations(input)
			assert.equal(nextGeneration.ok, true)
			if (nextGeneration.ok && nextGeneration.value.wb.kind === "enabled") {
				assert.notEqual(nextGeneration.value.wb.socket, parsed.value.wb.socket)
			}
			assert.ok(parsed.value.wb.socket.length < 104)
			assert.equal(prepareBashIntegrations(parsed.value).ok, true)
			assert.equal(fs.statSync(parsed.value.wb.runtimeDirectory).mode & 0o777, 0o700)
			assert.equal(cleanupBashIntegrations(parsed.value).ok, true)
			assert.equal(fs.existsSync(parsed.value.wb.runtimeDirectory), false)
		}
	})
})

test("derives the selected Docker context Unix socket without invoking Docker", () => {
	withTestTempDirectory("integrations-docker-context-", (root) => {
		const home = path.join(root, "home")
		const socket = path.join(root, "runtime", "docker.sock")
		const contextName = "test-context"
		const digest = createHash("sha256").update(contextName).digest("hex")
		const metadataDirectory = path.join(home, ".docker", "contexts", "meta", digest)
		fs.mkdirSync(metadataDirectory, { recursive: true })
		fs.mkdirSync(path.dirname(socket))
		fs.writeFileSync(path.join(home, ".docker", "config.json"), JSON.stringify({ currentContext: contextName }))
		fs.writeFileSync(
			path.join(metadataDirectory, "meta.json"),
			JSON.stringify({ Name: contextName, Endpoints: { docker: { Host: `unix://${socket}` } } }),
		)
		const parsed = parseBashIntegrations({
			environment: {
				path: "",
				sshAuthSock: undefined,
				dockerHost: undefined,
				dockerContext: undefined,
			},
			home: canonicalPath(home),
		})
		assert.equal(parsed.ok, true)
		if (parsed.ok) assert.deepEqual(parsed.value.docker, { kind: "unix-socket", socket: canonicalPath(socket) })
	})
})

test("rejects unsupported Docker endpoint protocols", () => {
	withTestTempDirectory("integrations-invalid-docker-", (root) => {
		const home = path.join(root, "home")
		fs.mkdirSync(home)
		const parsed = parseBashIntegrations({
			environment: {
				path: "",
				sshAuthSock: undefined,
				dockerHost: "file:///tmp/not-a-docker-endpoint",
				dockerContext: undefined,
			},
			home: canonicalPath(home),
		})
		assert.equal(parsed.ok, false)
		if (!parsed.ok) {
			assert.equal(parsed.error.kind, "invalid-integration-path")
			if (parsed.error.kind === "invalid-integration-path") assert.equal(parsed.error.integration, "docker")
		}
	})
})

test("uses disabled or network variants without inventing socket permissions", () => {
	withTestTempDirectory("integrations-disabled-", (root) => {
		const home = path.join(root, "home")
		fs.mkdirSync(home)
		const parsed = parseBashIntegrations({
			environment: {
				path: "",
				sshAuthSock: undefined,
				dockerHost: "tcp://127.0.0.1:2375",
				dockerContext: undefined,
			},
			home: canonicalPath(home),
		})
		assert.equal(parsed.ok, true)
		if (parsed.ok) {
			assert.deepEqual(parsed.value.nix, { kind: "disabled" })
			assert.deepEqual(parsed.value.sshAgent, { kind: "disabled" })
			assert.deepEqual(parsed.value.docker, { kind: "network" })
			assert.deepEqual(parsed.value.wb, { kind: "disabled" })
		}
	})
})

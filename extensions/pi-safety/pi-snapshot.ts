#!/usr/bin/env -S bun --no-env-file
import * as os from "node:os"
import * as path from "node:path"
import { loadProjectSafetyConfiguration } from "./configuration"
import { createSafetyFilesystem, createSandboxedSafetyFilesystem } from "./safety-filesystem"
import { SNAPSHOT_USAGE, parseSnapshotInvocation } from "./snapshot-cli"
import { runSnapshotCommand } from "./snapshot-commands"

export function main(args: readonly string[]): number {
	const invocation = parseSnapshotInvocation(args)
	if (!invocation.ok) {
		console.error(`pi-snapshot: ${invocation.error.message}\n${SNAPSHOT_USAGE}`)
		return 2
	}
	if (invocation.value.command.kind === "help") {
		console.log(SNAPSHOT_USAGE)
		return 0
	}
	const projectRoot = invocation.value.project.kind === "explicit" ? invocation.value.project.root : process.cwd()
	const home = process.env.HOME ?? os.homedir()
	const stateHome = process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state")
	const sandboxed = process.env.PI_SAFETY_CHECKPOINT_READY === "1"
	if (sandboxed && (invocation.value.command.kind === "create" || invocation.value.command.kind === "gc")) {
		console.error(`pi-snapshot: ${invocation.value.command.kind} is unavailable inside Pi Bash`)
		return 1
	}
	let filesystem: ReturnType<typeof createSafetyFilesystem>
	if (sandboxed) {
		filesystem = createSandboxedSafetyFilesystem({ cwd: projectRoot, stateHome })
	} else {
		const projectConfiguration = loadProjectSafetyConfiguration(projectRoot)
		if (!projectConfiguration.ok) {
			console.error(`pi-snapshot: configuration failed (${projectConfiguration.error.message})`)
			return 1
		}
		filesystem = createSafetyFilesystem({
			cwd: projectRoot,
			home,
			stateHome,
			piConfigDir: process.env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent"),
			additionalSecretPatterns: projectConfiguration.value.additionalSecretPatterns,
		})
	}
	if (!filesystem.ok) {
		console.error(`pi-snapshot: initialization failed (${filesystem.error.kind})`)
		return 1
	}
	const authority = sandboxed ? { kind: "sandboxed" as const } : { kind: "direct-user" as const }
	const result = runSnapshotCommand(filesystem.value.snapshotStore, invocation.value.command, authority)
	if (!result.ok) {
		console.error(`pi-snapshot: ${JSON.stringify(result.error)}`)
		return 1
	}
	if (result.value.length > 0) console.log(result.value)
	return 0
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))

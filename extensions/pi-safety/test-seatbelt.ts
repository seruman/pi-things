import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import type { CompiledSbpl } from "./sbpl"

export function runWithSeatbelt(compiled: CompiledSbpl, command: string, args: readonly string[] = []) {
	return runSeatbelt(`(version 1)\n(allow default)\n${compiled.source}`, compiled, command, args)
}

export function runWithSeatbeltProfile(
	compiled: CompiledSbpl,
	command: string,
	args: readonly string[] = [],
	cwd?: string,
	env?: NodeJS.ProcessEnv,
) {
	return runSeatbelt(compiled.source, compiled, command, args, cwd, env)
}

export function assertDenied(result: ReturnType<typeof runWithSeatbelt>): void {
	assert.notEqual(result.status, 0, `expected Seatbelt denial, stdout=${result.stdout}, stderr=${result.stderr}`)
}

function runSeatbelt(
	profile: string,
	compiled: CompiledSbpl,
	command: string,
	args: readonly string[],
	cwd?: string,
	env?: NodeJS.ProcessEnv,
) {
	const definitions = compiled.parameters.map(({ name, value }) => `-D${name}=${value}`)
	return spawnSync("/usr/bin/sandbox-exec", ["-p", profile, ...definitions, "--", command, ...args], {
		encoding: "utf8",
		cwd,
		env,
	})
}

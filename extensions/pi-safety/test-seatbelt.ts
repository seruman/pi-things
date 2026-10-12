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
	const diagnostic = `expected Seatbelt denial, stdout=${result.stdout}, stderr=${result.stderr}`
	assert.equal(result.error, undefined, diagnostic)
	assert.equal(result.signal, null, diagnostic)
	assert.ok(result.status !== null && result.status > 0, diagnostic)
	assert.match(result.stderr, /\bOperation not permitted\b/, diagnostic)
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
	const options = { encoding: "utf8" as const, cwd, env: { ...process.env, ...env, LC_ALL: "C" } }
	const prefix = ["-p", profile, ...definitions, "--"]
	const result = spawnSync("/usr/bin/sandbox-exec", [...prefix, command, ...args], options)

	if (result.status === 0) return result
	// Before interpreting failure as denial, prove the same profile can launch a command.
	const control = spawnSync("/usr/bin/sandbox-exec", [...prefix, "/usr/bin/true"], options)
	assert.equal(control.error, undefined, `Seatbelt control failed: ${control.error}`)
	assert.equal(control.signal, null, `Seatbelt control failed: ${control.signal}`)
	assert.equal(control.status, 0, `Seatbelt control failed: ${control.stderr}`)

	return result
}

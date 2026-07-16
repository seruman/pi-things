#!/usr/bin/env bun

import { appendFile } from "node:fs/promises"
import { readInvocationManifest } from "./invocation-manifest"
import { runShim } from "./shim-runner"

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	const manifestPath = process.env.SHELL_LEASH_INVOCATION
	if (!manifestPath) {
		process.stderr.write("shell-leash: missing SHELL_LEASH_INVOCATION\n")
		return 126
	}
	const manifest = await readInvocationManifest(manifestPath)
	if (!manifest.ok) {
		process.stderr.write(
			`shell-leash: invalid invocation manifest (${manifest.error.kind}): ${manifest.error.message}\n`,
		)
		return 126
	}
	const result = await runShim(manifest.value, argv, {
		cwd: process.cwd(),
		env: process.env,
		captureOutput: false,
	})
	for (const observation of result.observations) {
		try {
			await appendFile(
				manifest.value.observationLog,
				`${JSON.stringify({ version: 1, source: "shim", createdAt: new Date().toISOString(), argv, observation })}\n`,
				{ encoding: "utf8", mode: 0o600 },
			)
		} catch (cause) {
			process.stderr.write(
				`shell-leash: could not record runtime observation: ${cause instanceof Error ? cause.message : String(cause)}\n`,
			)
		}
	}
	if (result.kind !== "delegated") process.stderr.write(`${result.stderr}\n`)
	if (result.kind === "delegated" && result.signal) process.kill(process.pid, result.signal)
	return result.exitCode
}

if (import.meta.main) process.exitCode = await main()

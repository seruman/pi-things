import { type BashOperations, createLocalBashOperations } from "@earendil-works/pi-coding-agent"
import { type Result, err, ok } from "./result"
import type { CompiledSbpl } from "./sbpl"

export type BashLaunchError = { readonly kind: "nul-byte"; readonly field: "profile" | "parameter" | "command" }

export function compileSandboxedBashCommand(compiled: CompiledSbpl, command: string): Result<string, BashLaunchError> {
	if (compiled.source.includes("\0")) return err({ kind: "nul-byte", field: "profile" })
	if (command.includes("\0")) return err({ kind: "nul-byte", field: "command" })
	const argv = ["/usr/bin/sandbox-exec", "-p", compiled.source]
	for (const parameter of compiled.parameters) {
		const definition = `-D${parameter.name}=${parameter.value}`
		if (definition.includes("\0")) return err({ kind: "nul-byte", field: "parameter" })
		argv.push(definition)
	}
	argv.push("--", "/bin/bash", "-c", command)
	return ok(argv.map(shellQuote).join(" "))
}

export function createSandboxedBashOperations(
	profile: () => CompiledSbpl,
	environment: () => Readonly<NodeJS.ProcessEnv> = () => ({}),
): BashOperations {
	const local = createLocalBashOperations({ shellPath: "/bin/bash" })
	return {
		exec: async (command, cwd, options) => {
			const compiled = compileSandboxedBashCommand(profile(), command)
			if (!compiled.ok) throw new TypeError(`pi-safety: invalid Bash launch input (${compiled.error.field})`)
			return local.exec(compiled.value, cwd, { ...options, env: { ...options.env, ...environment() } })
		},
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`
}

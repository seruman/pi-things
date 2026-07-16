import * as path from "node:path"
import type { AnalysisObservation } from "./findings"

export type EmbeddedScriptExtraction = {
	readonly commands: readonly (readonly string[])[]
	readonly shellSources: readonly string[]
	readonly observations: readonly AnalysisObservation[]
}

export function extractEmbeddedScripts(argv: readonly string[]): EmbeddedScriptExtraction {
	const interpreter = path.basename(argv[0] ?? "")
	const code = codeArgument(argv)
	if (!code) return { commands: [], shellSources: [], observations: [] }
	if (/^python(?:\d+(?:\.\d+)*)?$/.test(interpreter)) return extractPython(interpreter, code)
	if (interpreter === "node" || interpreter === "nodejs" || interpreter === "bun")
		return extractJavaScript(interpreter, code)
	if (["ruby", "perl", "php"].includes(interpreter)) {
		return { commands: [], shellSources: [], observations: [{ kind: "embedded-dynamic", interpreter, source: code }] }
	}
	return { commands: [], shellSources: [], observations: [] }
}

function codeArgument(argv: readonly string[]): string | undefined {
	for (let index = 1; index < argv.length - 1; index++) {
		if (argv[index] === "-c" || argv[index] === "-e" || argv[index] === "--eval") return argv[index + 1]
	}
	return undefined
}

function extractPython(interpreter: string, source: string): EmbeddedScriptExtraction {
	const commands: string[][] = []
	const arrayPattern = /(?:subprocess\.(?:run|Popen|call|check_call|check_output)|os\.execv?p?)\s*\(\s*(\[[^\]]*\])/g
	for (const match of source.matchAll(arrayPattern)) {
		const array = match[1]
		if (!array) continue
		const argv = parseStringArray(array)
		if (argv) commands.push(argv)
	}
	const shellSources = [
		...source.matchAll(/(?:os\.system|subprocess\.(?:getoutput|getstatusoutput))\s*\(\s*(["'])(.*?)\1/g),
	].flatMap((match) => (match[2] ? [match[2]] : []))
	return resultOrDynamic(interpreter, source, commands, shellSources)
}

function extractJavaScript(interpreter: string, source: string): EmbeddedScriptExtraction {
	const commands: string[][] = []
	const processPattern = /(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*(["'])(git|gh)\1\s*,\s*(\[[^\]]*\])/g
	for (const match of source.matchAll(processPattern)) {
		const executable = match[2]
		const args = match[3] ? parseStringArray(match[3]) : undefined
		if (executable && args) commands.push([executable, ...args])
	}
	const shellSources = [...source.matchAll(/(?:exec|execSync)\s*\(\s*(["'`])(.*?)\1/g)].flatMap((match) =>
		match[2] ? [match[2]] : [],
	)
	return resultOrDynamic(interpreter, source, commands, shellSources)
}

function resultOrDynamic(
	interpreter: string,
	source: string,
	commands: readonly (readonly string[])[],
	shellSources: readonly string[],
): EmbeddedScriptExtraction {
	return commands.length > 0 || shellSources.length > 0
		? { commands, shellSources, observations: [] }
		: { commands: [], shellSources: [], observations: [{ kind: "embedded-dynamic", interpreter, source }] }
}

function parseStringArray(source: string): string[] | undefined {
	const input = source.trim()
	if (!input.startsWith("[") || !input.endsWith("]")) return undefined
	const values: string[] = []
	let index = 1
	while (index < input.length - 1) {
		while (/\s/.test(input[index] ?? "")) index++
		if (input[index] === ",") {
			index++
			continue
		}
		const quote = input[index]
		if (quote !== '"' && quote !== "'") return undefined
		index++
		let value = ""
		let closed = false
		while (index < input.length - 1) {
			const character = input[index]
			if (character === quote) {
				index++
				closed = true
				break
			}
			if (character === "\\") {
				const escaped = input[index + 1]
				if (escaped === undefined) return undefined
				value += escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped
				index += 2
				continue
			}
			value += character
			index++
		}
		if (!closed) return undefined
		values.push(value)
		while (/\s/.test(input[index] ?? "")) index++
		if (index < input.length - 1 && input[index] !== ",") return undefined
	}
	return values
}

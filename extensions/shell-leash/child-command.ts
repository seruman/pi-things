import * as path from "node:path"
import type { StaticWord } from "./static-word"

const XARGS_VALUE_OPTIONS = new Set([
	"-a",
	"--arg-file",
	"-d",
	"--delimiter",
	"-E",
	"--eof",
	"-I",
	"--replace",
	"-L",
	"--max-lines",
	"-n",
	"--max-args",
	"-P",
	"--max-procs",
	"-s",
	"--max-chars",
])

const PARALLEL_VALUE_OPTIONS = new Set([
	"-j",
	"--jobs",
	"-S",
	"--sshlogin",
	"--sshloginfile",
	"--results",
	"--tmpdir",
	"--workdir",
	"--wd",
	"--timeout",
	"--delay",
])

export function extractLiteralChildCommands(argv: readonly string[]): readonly (readonly StaticWord[])[] {
	switch (path.basename(argv[0] ?? "")) {
		case "xargs":
			return extractXargs(argv)
		case "find":
			return extractFind(argv)
		case "parallel":
			return extractParallel(argv)
		default:
			return []
	}
}

function extractXargs(argv: readonly string[]): readonly (readonly StaticWord[])[] {
	let index = 1
	let maxArguments: number | undefined
	while (index < argv.length) {
		const argument = argv[index]
		if (argument === "--") {
			index++
			break
		}
		if (!argument?.startsWith("-") || argument === "-") break
		const attachedMax = /^(?:-n|--max-args=)(\d+)$/.exec(argument)
		if (attachedMax?.[1]) maxArguments = Number.parseInt(attachedMax[1], 10)
		if (argument === "-n" || argument === "--max-args") {
			const value = argv[index + 1]
			if (value && /^\d+$/.test(value)) maxArguments = Number.parseInt(value, 10)
		}
		if (XARGS_VALUE_OPTIONS.has(argument)) index++
		index++
	}
	if (index >= argv.length) return []
	const child = argv.slice(index).map(literalWord)
	if (maxArguments !== undefined) {
		for (let argument = 0; argument < maxArguments; argument++) child.push(dynamicWord("<xargs-input>"))
	}
	return [child]
}

function extractFind(argv: readonly string[]): readonly (readonly StaticWord[])[] {
	const commands: StaticWord[][] = []
	for (let index = 1; index < argv.length; index++) {
		if (argv[index] !== "-exec" && argv[index] !== "-execdir") continue
		const command: StaticWord[] = []
		for (index++; index < argv.length; index++) {
			const argument = argv[index]
			if (argument === ";" || argument === "+") break
			if (argument !== undefined) command.push(argument.includes("{}") ? dynamicWord(argument) : literalWord(argument))
		}
		if (command.length > 0) commands.push(command)
	}
	return commands
}

function extractParallel(argv: readonly string[]): readonly (readonly StaticWord[])[] {
	let index = 1
	while (index < argv.length) {
		const argument = argv[index]
		if (argument === "--") {
			index++
			break
		}
		if (!argument?.startsWith("-") || argument === "-") break
		if (PARALLEL_VALUE_OPTIONS.has(argument)) index++
		index++
	}
	const separator = argv.findIndex(
		(argument, argumentIndex) => argumentIndex >= index && (argument === ":::" || argument === "::::"),
	)
	const end = separator < 0 ? argv.length : separator
	if (index >= end) return []
	const child = argv
		.slice(index, end)
		.map((argument) => (argument.includes("{") ? dynamicWord(argument) : literalWord(argument)))
	if (!child.some((word) => word.kind === "composite") && separator >= 0) child.push(dynamicWord("<parallel-input>"))
	return [child]
}

function literalWord(value: string): StaticWord {
	return { kind: "literal", value }
}

function dynamicWord(source: string): StaticWord {
	return { kind: "composite", source, parts: [{ kind: "other-dynamic", source }], knownPrefix: "", knownSuffix: "" }
}

import * as path from "node:path"
import { analyzeResolvedCommand, analyzeStaticCommand, parseGitHubRepositoryTarget } from "./analyze-command"
import { extractLiteralChildCommands } from "./child-command"
import type { RepositoryTarget } from "./effects"
import { extractEmbeddedScripts } from "./embedded-script"
import type { CommandAnalysis, CommandSourceKind, EffectFinding } from "./findings"
import { gitEnvironmentCwd, gitInvocationCwd, staticGitInvocationCwd } from "./git-context"
import { resolveRepositoryContext } from "./repository-target"
import {
	type ParsedShellAssignment,
	type ParsedShellCommand,
	type ParsedShellFunction,
	type ParsedShellWord,
	parseShell,
} from "./shell-parser"
import type { StaticWord } from "./static-word"

export type ShellCommandInput = {
	readonly source: string
	readonly cwd: string
	readonly environment?: Readonly<Record<string, string | undefined>>
}

const MAX_RECURSION_DEPTH = 10

export async function analyzeShellCommand(input: ShellCommandInput): Promise<CommandAnalysis> {
	const resolvedContext = await resolveRepositoryContext(input.cwd)
	const repository: RepositoryTarget = resolvedContext.ok ? resolvedContext.value.repository : { kind: "unknown" }
	const gitRemotes = resolvedContext.ok ? resolvedContext.value.remotes : new Map<string, string>()
	const gitDefaultBranch = resolvedContext.ok ? resolvedContext.value.currentBranch : undefined
	const environment = new Map<string, StaticWord>()
	for (const name of ["GH_REPO", "GIT_DIR", "GIT_WORK_TREE"] as const) {
		const value = input.environment?.[name]
		if (value) environment.set(name, { kind: "literal", value })
	}
	return analyzeShellSource(
		input.source,
		input.cwd,
		repository,
		gitRemotes,
		gitDefaultBranch,
		environment,
		"top-level",
		0,
	)
}

async function analyzeShellSource(
	source: string,
	cwd: string,
	repository: RepositoryTarget,
	gitRemotes: ReadonlyMap<string, string>,
	gitDefaultBranch: string | undefined,
	environment: ReadonlyMap<string, StaticWord>,
	sourceKind: CommandSourceKind,
	depth: number,
): Promise<CommandAnalysis> {
	if (depth >= MAX_RECURSION_DEPTH) {
		return { findings: [], observations: [{ kind: "recursion-limit", source }] }
	}
	const parsed = await parseShell(source)
	if (!parsed.ok) {
		return {
			findings: [],
			observations: [
				{
					kind: "parser-failure",
					stage: parsed.error.kind,
					message: parsed.error.message,
				},
			],
		}
	}

	const observations: CommandAnalysis["observations"][number][] = parsed.value.issues.map((issue) => ({
		kind: "shell-syntax",
		issue: issue.kind,
		text: issue.text,
		startByte: issue.range.startByte,
		endByte: issue.range.endByte,
	}))
	const commands = await analyzeParsedCommands(
		parsed.value.commands,
		parsed.value.assignments,
		parsed.value.functions,
		cwd,
		repository,
		gitRemotes,
		gitDefaultBranch,
		environment,
		sourceKind,
		depth,
	)
	observations.push(...commands.observations)
	return { findings: commands.findings, observations }
}

async function analyzeParsedCommands(
	commands: readonly ParsedShellCommand[],
	assignments: readonly ParsedShellAssignment[],
	functions: readonly ParsedShellFunction[],
	cwd: string,
	repository: RepositoryTarget,
	gitRemotes: ReadonlyMap<string, string>,
	gitDefaultBranch: string | undefined,
	environment: ReadonlyMap<string, StaticWord>,
	sourceKind: CommandSourceKind,
	depth: number,
): Promise<CommandAnalysis> {
	const findings: EffectFinding[] = []
	const observations: CommandAnalysis["observations"][number][] = []
	const scopeCwds = new Map<string, string>([["", cwd]])
	const scopeEnvironments = new Map<string, Map<string, StaticWord>>([["", new Map(environment)]])
	const repositories = new Map<string, RepositoryTarget>([[cwd, repository]])
	const remoteMaps = new Map<string, ReadonlyMap<string, string>>([[cwd, gitRemotes]])
	const defaultBranches = new Map<string, string | undefined>([[cwd, gitDefaultBranch]])
	const orderedAssignments = [...assignments].sort((left, right) => left.range.startByte - right.range.startByte)
	let assignmentIndex = 0
	for (const command of commands) {
		while (
			(orderedAssignments[assignmentIndex]?.range.endByte ?? Number.POSITIVE_INFINITY) <= command.range.startByte
		) {
			const assignment = orderedAssignments[assignmentIndex]
			if (!assignment) break
			environmentForScopes(scopeEnvironments, assignment.scopes).set(assignment.name, assignment.value.value)
			assignmentIndex++
		}
		const scopeKey = command.scopes.join("/")
		const commandSourceKind = sourceKindForScopes(command.scopes, sourceKind)
		let commandCwd = cwd
		for (let depth = 0; depth <= command.scopes.length; depth++) {
			const key = command.scopes.slice(0, depth).join("/")
			const known = scopeCwds.get(key)
			if (known) commandCwd = known
			else scopeCwds.set(key, commandCwd)
		}
		const inheritedEnvironment = new Map(environmentForScopes(scopeEnvironments, command.scopes))
		const commandEnvironment = new Map(inheritedEnvironment)
		for (const assignment of command.assignments) commandEnvironment.set(assignment.name, assignment.value.value)
		const unwrapped = unwrapCommandWords(command.words, commandCwd)
		const commandWords = unwrapped.words
		commandCwd = unwrapped.cwd
		const literalCommand = literalArgv(commandWords)
		if (literalCommand?.[0] === "unset" && literalCommand.length === 2) {
			environmentForScopes(scopeEnvironments, command.scopes).delete(literalCommand[1] ?? "")
			continue
		}
		if (commandWords[0]?.value.kind === "literal" && commandWords[0].value.value === "cd") {
			if (literalCommand?.[1] && literalCommand.length === 2) {
				scopeCwds.set(scopeKey, path.resolve(commandCwd, literalCommand[1]))
			} else {
				for (let index = 1; index < commandWords.length; index++) {
					const word = commandWords[index]?.value
					if (word?.kind === "composite") observations.push({ kind: "dynamic-argument", source: word.source, index })
				}
			}
			continue
		}
		const environmentCwd = staticGitEnvironmentCwd(commandEnvironment, commandCwd, observations)
		const repositoryCwd = literalCommand
			? gitInvocationCwd(literalCommand, environmentCwd)
			: staticGitInvocationCwd(
					commandWords.map((word) => word.value),
					environmentCwd,
				)
		let commandRepository = repositories.get(repositoryCwd)
		let commandGitRemotes = remoteMaps.get(repositoryCwd)
		let commandGitDefaultBranch = defaultBranches.get(repositoryCwd)
		if (!commandRepository || !commandGitRemotes) {
			const resolved = await resolveRepositoryContext(repositoryCwd)
			commandRepository = resolved.ok ? resolved.value.repository : { kind: "unknown" }
			commandGitRemotes = resolved.ok ? resolved.value.remotes : new Map()
			commandGitDefaultBranch = resolved.ok ? resolved.value.currentBranch : undefined
			repositories.set(repositoryCwd, commandRepository)
			remoteMaps.set(repositoryCwd, commandGitRemotes)
			defaultBranches.set(repositoryCwd, commandGitDefaultBranch)
		}
		const executable = commandWords[0]
		if (!executable) continue
		if (executable.value.kind === "composite") {
			observations.push({
				kind: "dynamic-executable",
				source: executable.value.source,
				startByte: executable.range.startByte,
				endByte: executable.range.endByte,
			})
			continue
		}
		const ghRepo = commandEnvironment.get("GH_REPO")
		const githubRepository = ghRepo?.kind === "literal" ? parseGitHubRepositoryTarget(ghRepo.value) : undefined
		if (ghRepo?.kind === "composite") {
			observations.push({ kind: "dynamic-argument", source: ghRepo.source, index: -1 })
		}
		const staticAnalysis = analyzeStaticCommand({
			argv: commandWords.map((word) => word.value),
			cwd: commandCwd,
			repository: commandRepository,
			githubRepository,
			gitRemotes: commandGitRemotes,
			gitDefaultBranch: commandGitDefaultBranch,
		})
		findings.push(...withCommandSource(staticAnalysis.findings, commandSourceKind, command.range))
		observations.push(...staticAnalysis.observations)
		const argv = literalCommand
		if (!argv) continue
		for (const childArgv of extractLiteralChildCommands(argv)) {
			const childAnalysis = analyzeStaticCommand({
				argv: childArgv,
				cwd: commandCwd,
				repository: commandRepository,
				githubRepository,
				gitRemotes: commandGitRemotes,
				gitDefaultBranch: commandGitDefaultBranch,
			})
			findings.push(...withCommandSource(childAnalysis.findings, "child-command", command.range))
			observations.push(...childAnalysis.observations)
		}
		const embedded = extractEmbeddedScripts(argv)
		observations.push(...embedded.observations)
		for (const embeddedArgv of embedded.commands) {
			const embeddedAnalysis = analyzeResolvedCommand({
				argv: embeddedArgv,
				cwd: commandCwd,
				repository: commandRepository,
				githubRepository,
				gitRemotes: commandGitRemotes,
				gitDefaultBranch: commandGitDefaultBranch,
			})
			findings.push(...withCommandSource(embeddedAnalysis.findings, "embedded-script", command.range))
			observations.push(...embeddedAnalysis.observations)
		}
		for (const embeddedSource of embedded.shellSources) {
			const embeddedAnalysis = await analyzeShellSource(
				embeddedSource,
				commandCwd,
				commandRepository,
				commandGitRemotes,
				commandGitDefaultBranch,
				commandEnvironment,
				"embedded-script",
				depth + 1,
			)
			findings.push(...embeddedAnalysis.findings)
			observations.push(...embeddedAnalysis.observations)
		}
		const functionDefinition = functions.find((candidate) => candidate.name === argv[0])
		if (functionDefinition) {
			if (depth + 1 >= MAX_RECURSION_DEPTH) {
				observations.push({ kind: "recursion-limit", source: argv.join(" ") })
				continue
			}
			const functionAnalysis = await analyzeParsedCommands(
				functionDefinition.commands,
				[],
				functions,
				commandCwd,
				commandRepository,
				commandGitRemotes,
				commandGitDefaultBranch,
				commandEnvironment,
				"function",
				depth + 1,
			)
			findings.push(...functionAnalysis.findings)
			observations.push(...functionAnalysis.observations)
			continue
		}
		const nested = nestedShellSource(argv)
		if (!nested) continue
		const nestedAnalysis = await analyzeShellSource(
			nested,
			commandCwd,
			commandRepository,
			commandGitRemotes,
			commandGitDefaultBranch,
			commandEnvironment,
			"nested-shell",
			depth + 1,
		)
		findings.push(...nestedAnalysis.findings)
		observations.push(...nestedAnalysis.observations)
	}
	return { findings, observations }
}

function sourceKindForScopes(scopes: readonly string[], fallback: CommandSourceKind): CommandSourceKind {
	for (let index = scopes.length - 1; index >= 0; index--) {
		const scope = scopes[index] ?? ""
		if (scope.startsWith("command_substitution:")) return "command-substitution"
		if (scope.startsWith("process_substitution:")) return "process-substitution"
		if (scope.startsWith("subshell:")) return "subshell"
	}
	return fallback
}

function withCommandSource(
	findings: readonly EffectFinding[],
	kind: CommandSourceKind,
	range: { readonly startByte: number; readonly endByte: number },
): readonly EffectFinding[] {
	return findings.map((finding) => ({
		...finding,
		evidence: { ...finding.evidence, source: { kind, startByte: range.startByte, endByte: range.endByte } },
	}))
}

function environmentForScopes(
	environments: Map<string, Map<string, StaticWord>>,
	scopes: readonly string[],
): Map<string, StaticWord> {
	let environment = environments.get("") ?? new Map<string, StaticWord>()
	for (let depth = 1; depth <= scopes.length; depth++) {
		const key = scopes.slice(0, depth).join("/")
		const known = environments.get(key)
		if (known) environment = known
		else {
			environment = new Map(environment)
			environments.set(key, environment)
		}
	}
	return environment
}

function literalArgv(words: readonly ParsedShellWord[]): readonly string[] | undefined {
	const argv: string[] = []
	for (const word of words) {
		if (word.value.kind !== "literal") return undefined
		argv.push(word.value.value)
	}
	return argv
}

function staticGitEnvironmentCwd(
	environment: ReadonlyMap<string, StaticWord>,
	cwd: string,
	observations: CommandAnalysis["observations"][number][],
): string {
	const workTree = environment.get("GIT_WORK_TREE")
	if (workTree?.kind === "literal") return gitEnvironmentCwd(cwd, workTree.value)
	if (workTree?.kind === "composite")
		observations.push({ kind: "dynamic-argument", source: workTree.source, index: -1 })
	const gitDirectory = environment.get("GIT_DIR")
	if (gitDirectory?.kind === "literal") return gitEnvironmentCwd(cwd, undefined, gitDirectory.value)
	if (gitDirectory?.kind === "composite")
		observations.push({ kind: "dynamic-argument", source: gitDirectory.source, index: -1 })
	return cwd
}

function unwrapCommandWords(
	input: readonly ParsedShellWord[],
	initialCwd: string,
): { readonly words: readonly ParsedShellWord[]; readonly cwd: string } {
	let words = input
	let cwd = initialCwd
	for (let iteration = 0; iteration < 8; iteration++) {
		const head = words[0]?.value
		if (head?.kind !== "literal") return { words, cwd }
		const headName = path.basename(head.value)
		if (headName === "env") {
			let index = 1
			while (index < words.length) {
				const value = words[index]?.value
				if (value?.kind !== "literal") break
				if (value.value === "--") {
					index++
					break
				}
				if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value.value)) {
					index++
					continue
				}
				if (["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-P"].includes(value.value)) {
					const optionValue = words[index + 1]?.value
					if ((value.value === "-C" || value.value === "--chdir") && optionValue?.kind === "literal") {
						cwd = path.resolve(cwd, optionValue.value)
					}
					index += 2
					continue
				}
				if (value.value.startsWith("--chdir=")) {
					cwd = path.resolve(cwd, value.value.slice("--chdir=".length))
					index++
					continue
				}
				if (value.value.startsWith("-")) {
					index++
					continue
				}
				break
			}
			words = words.slice(index)
			continue
		}
		if (headName === "nohup" || headName === "exec") {
			words = words.slice(1)
			continue
		}
		if (headName === "time" || headName === "nice") {
			let index = 1
			while (index < words.length) {
				const option = words[index]?.value
				if (option?.kind !== "literal" || !option.value.startsWith("-")) break
				if (["-f", "--format", "-o", "--output", "-n", "--adjustment"].includes(option.value)) index++
				index++
			}
			words = words.slice(index)
			continue
		}
		if (headName === "command" || headName === "sudo") {
			let index = 1
			const valueOptions = new Set(["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--chdir"])
			while (index < words.length) {
				const option = words[index]?.value
				if (option?.kind !== "literal") break
				if (option.value === "--") {
					index++
					break
				}
				if (!option.value.startsWith("-")) break
				if (headName === "sudo" && (option.value === "-C" || option.value === "--chdir")) {
					const optionValue = words[index + 1]?.value
					if (optionValue?.kind === "literal") cwd = path.resolve(cwd, optionValue.value)
				}
				if (headName === "sudo" && option.value.startsWith("--chdir=")) {
					cwd = path.resolve(cwd, option.value.slice("--chdir=".length))
				}
				index += headName === "sudo" && valueOptions.has(option.value) ? 2 : 1
			}
			words = words.slice(index)
			continue
		}
		return { words, cwd }
	}
	return { words, cwd }
}

function nestedShellSource(argv: readonly string[]): string | undefined {
	let index = 0
	if (argv[index] === "env") {
		index++
		while (argv[index]?.includes("=")) index++
	}
	if (argv[index] === "command") index++
	const shell = path.basename(argv[index] ?? "")
	if (shell !== "sh" && shell !== "bash" && shell !== "zsh") return undefined
	for (let argumentIndex = index + 1; argumentIndex < argv.length - 1; argumentIndex++) {
		const flag = argv[argumentIndex]
		if (flag === "-c" || flag === "-lc") return argv[argumentIndex + 1]
	}
	return undefined
}

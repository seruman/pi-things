import {
	type CommandNode,
	type ScriptNode,
	type SimpleCommandNode,
	type StatementNode,
	type WordNode,
	parse,
} from "just-bash"

type Argv = string[]

// WordPart is not re-exported from just-bash's main entry point.
type WordPart = WordNode["parts"][number]

type CapabilityRule = {
	id: string
	match: (argv: Argv) => boolean
}

export type Capability = {
	id: string
	description: string
	rules: CapabilityRule[]
}

export type CapabilityHit = {
	capability: string
	rule: string
	description: string
	source: string
	argv: Argv
	command: string
}

export type AnalysisIssue = {
	source: string
	error: string
}

export type ShellAnalysis = {
	input: string
	issues: AnalysisIssue[]
	hits: CapabilityHit[]
}

export type AnalyseShellCommandOptions = {
	capabilities?: Capability[]
}

function capability(id: string, description: string, rules: CapabilityRule[]): Capability {
	return { id, description, rules }
}

function commandStartsWith(argv: Argv, ...parts: string[]): boolean {
	return parts.every((part, index) => argv[index] === part)
}

function commandRule(id: string, parts: string[], predicate?: (argv: Argv) => boolean): CapabilityRule {
	return {
		id,
		match: (argv) => commandStartsWith(argv, ...parts) && (predicate ? predicate(argv) : true),
	}
}

function isShell(arg: string | undefined): boolean {
	return arg === "sh" || arg === "bash"
}

function unwrapShellWrapper(argv: Argv): Argv | null {
	if (isShell(argv[0])) return argv

	if (argv[0] === "command" && isShell(argv[1])) return argv.slice(1)

	if (argv[0] === "env") {
		let i = 1
		while (i < argv.length && argv[i]?.includes("=")) i++
		if (argv[i] === "command") i++
		if (isShell(argv[i])) return argv.slice(i)
	}

	return null
}

export const DEFAULT_CAPABILITIES: Capability[] = [
	capability("fs.rm", "Run rm", [commandRule("fs.rm", ["rm"])]),
	capability("git.commit.amend", "Run git commit --amend", [
		commandRule("git.commit.amend", ["git", "commit"], (argv) => argv.includes("--amend")),
	]),
	capability("git.checkout", "Run git checkout", [
		commandRule("git.checkout.ours", ["git", "checkout"], (argv) => argv.includes("--ours")),
		commandRule("git.checkout.theirs", ["git", "checkout"], (argv) => argv.includes("--theirs")),
		commandRule("git.checkout.path", ["git", "checkout"], (argv) => argv.includes("--")),
		commandRule("git.checkout.branch", ["git", "checkout"]),
	]),
	capability("git.switch", "Run git switch", [commandRule("git.switch", ["git", "switch"])]),
	capability("git.restore", "Run git restore", [
		commandRule("git.restore.staged", ["git", "restore"], (argv) => argv.includes("--staged")),
		commandRule("git.restore.source", ["git", "restore"], (argv) => {
			const sourceIndex = argv.indexOf("--source")
			return argv.some((arg) => arg.startsWith("--source=")) || (sourceIndex >= 0 && sourceIndex < argv.length - 1)
		}),
		commandRule("git.restore.path", ["git", "restore"]),
	]),
	capability("git.reset", "Run git reset", [
		commandRule("git.reset.soft", ["git", "reset"], (argv) => argv.includes("--soft")),
		commandRule("git.reset.mixed", ["git", "reset"], (argv) => argv.includes("--mixed")),
		commandRule("git.reset.default", ["git", "reset"], (argv) => !argv.includes("--hard")),
	]),
	capability("git.reset.hard", "Run git reset --hard", [
		commandRule("git.reset.hard", ["git", "reset"], (argv) => argv.includes("--hard")),
	]),
	capability("git.clean", "Run git clean", [commandRule("git.clean", ["git", "clean"])]),
	capability("git.config.global", "Run git config --global", [
		commandRule("git.config.global", ["git", "config"], (argv) => argv.includes("--global")),
	]),
	capability("git.push", "Run git push", [
		commandRule(
			"git.push.default",
			["git", "push"],
			(argv) => !argv.includes("--force") && !argv.includes("-f") && !argv.includes("--force-with-lease"),
		),
	]),
	capability("git.push.force", "Run git push --force", [
		commandRule("git.push.force", ["git", "push"], (argv) => argv.includes("--force") || argv.includes("-f")),
		commandRule("git.push.force-with-lease", ["git", "push"], (argv) => argv.includes("--force-with-lease")),
	]),
	capability("gh.pr.create", "Run gh pr create", [commandRule("gh.pr.create", ["gh", "pr", "create"])]),
	capability("gh.pr.comment", "Run gh pr comment", [commandRule("gh.pr.comment", ["gh", "pr", "comment"])]),
	capability("gh.pr.merge", "Run gh pr merge", [commandRule("gh.pr.merge", ["gh", "pr", "merge"])]),
	capability("gh.issue.create", "Run gh issue create", [commandRule("gh.issue.create", ["gh", "issue", "create"])]),
	capability("gh.issue.comment", "Run gh issue comment", [commandRule("gh.issue.comment", ["gh", "issue", "comment"])]),
]

export function analyseShellCommand(input: string, options: AnalyseShellCommandOptions = {}): ShellAnalysis {
	const { capabilities = DEFAULT_CAPABILITIES } = options
	const issues: AnalysisIssue[] = []
	const hits: CapabilityHit[] = []

	let ast: ScriptNode
	try {
		ast = parse(input)
	} catch (error) {
		return {
			input,
			issues: [{ source: "top-level", error: toErrorMessage(error) }],
			hits: [],
		}
	}

	const visitCommand = (argv: Argv, source: string) => {
		if (argv.length === 0) return

		for (const entry of capabilities) {
			for (const rule of entry.rules) {
				if (!rule.match(argv)) continue
				hits.push({
					capability: entry.id,
					rule: rule.id,
					description: entry.description,
					source,
					argv,
					command: argv.join(" "),
				})
				break
			}
		}

		const nested = nestedShellSource(argv)
		if (!nested) return
		const nestedSource = `${source} > ${nested.shell} ${nested.flag}`
		try {
			const nestedAst = parse(nested.script)
			walkScript(nestedAst, nestedSource, visitCommand)
		} catch (error) {
			issues.push({
				source: nestedSource,
				error: toErrorMessage(error),
			})
		}
	}

	walkScript(ast, "top-level", visitCommand)

	return {
		input,
		issues,
		hits,
	}
}

function nestedShellSource(argv: Argv): { shell: string; flag: "-c" | "-lc"; script: string } | null {
	const nestedArgv = unwrapShellWrapper(argv)
	if (!nestedArgv) return null
	for (let index = 1; index < nestedArgv.length - 1; index++) {
		const flag = nestedArgv[index]
		if (flag !== "-c" && flag !== "-lc") continue
		return { shell: nestedArgv[0], flag, script: nestedArgv[index + 1] }
	}
	return null
}

function walkScript(script: ScriptNode, source: string, onCommand: (argv: Argv, source: string) => void) {
	for (const statement of script.statements) {
		walkStatement(statement, source, onCommand)
	}
}

function walkStatement(statement: StatementNode, source: string, onCommand: (argv: Argv, source: string) => void) {
	for (const pipeline of statement.pipelines) {
		for (const command of pipeline.commands) {
			walkCommand(command, source, onCommand)
		}
	}
}

function walkCommand(command: CommandNode, source: string, onCommand: (argv: Argv, source: string) => void) {
	switch (command.type) {
		case "SimpleCommand": {
			const argv = toArgv(command)
			onCommand(argv, source)
			if (command.name) walkWord(command.name, source, onCommand)
			for (const arg of command.args) walkWord(arg, source, onCommand)
			for (const assignment of command.assignments) {
				if (assignment.value) walkWord(assignment.value, source, onCommand)
				for (const item of assignment.array ?? []) walkWord(item, source, onCommand)
			}
			return
		}
		case "If":
			for (const clause of command.clauses) {
				for (const condition of clause.condition) walkStatement(condition, source, onCommand)
				for (const body of clause.body) walkStatement(body, source, onCommand)
			}
			for (const body of command.elseBody ?? []) walkStatement(body, source, onCommand)
			return
		case "For":
			for (const word of command.words ?? []) walkWord(word, source, onCommand)
			for (const body of command.body) walkStatement(body, source, onCommand)
			return
		case "While":
		case "Until":
			for (const condition of command.condition) walkStatement(condition, source, onCommand)
			for (const body of command.body) walkStatement(body, source, onCommand)
			return
		case "CStyleFor":
		case "Subshell":
		case "Group":
			for (const body of command.body) walkStatement(body, source, onCommand)
			return
		case "Case":
			walkWord(command.word, source, onCommand)
			for (const item of command.items) {
				for (const body of item.body) walkStatement(body, source, onCommand)
			}
			return
		case "FunctionDef":
			walkCommand(command.body, source, onCommand)
			return
		default:
			return
	}
}

function walkWord(word: WordNode, source: string, onCommand: (argv: Argv, source: string) => void) {
	for (const part of word.parts) {
		switch (part.type) {
			case "CommandSubstitution":
				walkScript(part.body, `${source} > command-substitution`, onCommand)
				break
			case "ProcessSubstitution":
				walkScript(part.body, `${source} > process-substitution`, onCommand)
				break
			case "DoubleQuoted":
				for (const inner of part.parts) {
					if (inner.type === "CommandSubstitution") {
						walkScript(inner.body, `${source} > command-substitution`, onCommand)
					}
					if (inner.type === "ProcessSubstitution") {
						walkScript(inner.body, `${source} > process-substitution`, onCommand)
					}
				}
				break
		}
	}
}

function toArgv(command: SimpleCommandNode): Argv {
	const argv = command.name ? [wordToText(command.name)] : []
	for (const arg of command.args) argv.push(wordToText(arg))
	return argv.filter(Boolean)
}

function wordToText(word: WordNode): string {
	return word.parts.map(partToText).join("")
}

function partToText(part: WordPart): string {
	switch (part.type) {
		case "Literal":
		case "SingleQuoted":
		case "Escaped":
			return part.value
		case "DoubleQuoted":
			return part.parts.map(partToText).join("")
		case "CommandSubstitution":
			return "$(...)"
		case "ProcessSubstitution":
			return "<(...)"
		case "ParameterExpansion":
			return "$"
		case "ArithmeticExpansion":
			return "$((..))"
		case "TildeExpansion":
			return part.user ? `~${part.user}` : "~"
		case "BraceExpansion":
			return "{...}"
		case "Glob":
			return part.pattern
		default:
			return part satisfies never
	}
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

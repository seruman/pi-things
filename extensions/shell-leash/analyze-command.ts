import * as path from "node:path"
import type { GitHubEffect, GitHubOperationDetails, GitHubTarget, GitPushEffect, RepositoryTarget } from "./effects"
import type { CommandAnalysis } from "./findings"
import { githubCommandOperation, isReadOnlyGitHubCommand } from "./github-operations"
import { parseRepositoryUrl } from "./repository-target"
import type { StaticWord } from "./static-word"

export type ResolvedCommand = {
	readonly argv: readonly string[]
	readonly cwd: string
	readonly repository?: RepositoryTarget
	readonly githubRepository?: GitHubTarget
	readonly gitRemotes?: ReadonlyMap<string, string>
	readonly gitDefaultBranch?: string
}

export type StaticCommand = {
	readonly argv: readonly StaticWord[]
	readonly cwd: string
	readonly repository?: RepositoryTarget
	readonly githubRepository?: GitHubTarget
	readonly gitRemotes?: ReadonlyMap<string, string>
	readonly gitDefaultBranch?: string
}

const PUSH_FLAGS_WITH_VALUE = new Set(["--receive-pack", "--exec", "-o", "--push-option"])

export function analyzeResolvedCommand(command: ResolvedCommand): CommandAnalysis {
	const [executable] = command.argv
	const executableName = path.basename(executable ?? "")
	if (executableName === "gh") return analyzeResolvedGitHubCommand(command)
	if (executableName !== "git") return { findings: [], observations: [] }
	if (
		["--version", "--help", "-h", "--exec-path", "--html-path", "--man-path", "--info-path"].includes(
			command.argv[1] ?? "",
		)
	) {
		return { findings: [], observations: [] }
	}
	const config = gitInvocationConfig(command.argv)
	const configObservations = config.settings.map(({ setting, value }) => ({
		kind: "git-scope-override" as const,
		setting,
		value,
	}))
	let invocation = parseGitInvocation(command.argv)
	if (!invocation) {
		return { findings: [], observations: [...configObservations, { kind: "unknown-git", argv: command.argv }] }
	}
	const alias = config.aliases.get(invocation.subcommand)
	if (alias) {
		const expanded = plainGitAliasWords(alias)
		invocation = expanded
			? { subcommand: expanded[0] ?? "", args: [...expanded.slice(1), ...invocation.args] }
			: invocation
	}
	if (invocation.subcommand === "send-pack") invocation = { subcommand: "push", args: invocation.args }
	if (invocation.subcommand === "subtree") {
		const subtreePush = subtreePushArgs(invocation.args)
		if (subtreePush) invocation = { subcommand: "push", args: subtreePush }
	}
	if (invocation.subcommand !== "push") {
		return KNOWN_NON_PUSH_GIT_COMMANDS.has(invocation.subcommand)
			? { findings: [], observations: configObservations }
			: { findings: [], observations: [...configObservations, { kind: "unknown-git", argv: command.argv }] }
	}
	const { args } = invocation
	if (args.some(isPushDryRunOption)) return { findings: [], observations: configObservations }
	const effectiveCommand: ResolvedCommand = config.hasUrlRewrite
		? { ...command, repository: { kind: "unknown" }, gitRemotes: new Map() }
		: command

	let force: GitPushEffect["details"]["force"] = "none"
	let deleteRefs = false
	let all = false
	let mirror = false
	let tags = false
	let prune = false
	const positional: string[] = []
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === "--") {
			positional.push(...args.slice(index + 1))
			break
		}
		const forceOption = arg ? pushForceKind(arg) : undefined
		const deleteOption = arg ? isPushDeleteOption(arg) : false
		if (forceOption) force = forceOption
		if (deleteOption) deleteRefs = true
		if (forceOption || deleteOption) continue
		if (arg === "--all") all = true
		if (arg === "--mirror") mirror = true
		if (arg === "--tags") tags = true
		if (arg === "--prune") prune = true
		if (arg === "--repo") {
			const value = args[index + 1]
			if (value !== undefined) positional.push(value)
			index++
			continue
		}
		if (arg?.startsWith("--repo=")) {
			positional.push(arg.slice("--repo=".length))
			continue
		}
		if (arg && PUSH_FLAGS_WITH_VALUE.has(arg) && !arg.includes("=")) {
			index++
			continue
		}
		if (arg?.startsWith("-")) continue
		if (arg !== undefined) positional.push(arg)
	}
	const [remote, ...explicitRefspecs] = positional
	const refspecs =
		explicitRefspecs.length === 0 && command.gitDefaultBranch && !all && !mirror && !tags && !prune && !deleteRefs
			? [command.gitDefaultBranch]
			: explicitRefspecs
	if (refspecs.some((refspec) => refspec.startsWith("+"))) force = "force"
	const hasDeleteRefspec = refspecs.some((refspec) => refspec.startsWith(":"))
	const operation =
		deleteRefs || hasDeleteRefspec || mirror || prune
			? "git.push.delete"
			: force === "none"
				? "git.push"
				: "git.push.force"
	const explicitRepository = remote ? parseRepositoryUrl(remote) : { kind: "unknown" as const }
	const configuredRemoteUrl =
		remote && explicitRepository.kind === "unknown" ? effectiveCommand.gitRemotes?.get(remote) : undefined
	const configuredRepository = configuredRemoteUrl
		? parseRepositoryUrl(configuredRemoteUrl)
		: { kind: "unknown" as const }
	const repository =
		explicitRepository.kind === "repository"
			? explicitRepository
			: configuredRepository.kind === "repository"
				? configuredRepository
				: (effectiveCommand.repository ?? explicitRepository)
	const effect: GitPushEffect = {
		kind: "git-push",
		operation,
		remote:
			remote === undefined
				? { kind: "implicit" }
				: explicitRepository.kind === "repository"
					? { kind: "url", url: remote }
					: { kind: "named", name: remote },
		refspecs: refspecs.map((refspec) => {
			if (deleteRefs) return { kind: "delete", destination: refspec }
			if (refspec.startsWith(":")) return { kind: "delete", destination: refspec.slice(1) }
			const normalized = refspec.startsWith("+") ? refspec.slice(1) : refspec
			const separator = normalized.indexOf(":")
			return separator < 0
				? { kind: "source", source: normalized }
				: { kind: "mapping", source: normalized.slice(0, separator), destination: normalized.slice(separator + 1) }
		}),
		repository,
		details: {
			force,
			destination: remote === undefined ? "implicit" : "explicit",
			all,
			mirror,
			tags,
			prune,
		},
	}

	return {
		findings: [
			{
				effect,
				evidence: { analyzer: "git", argv: command.argv },
				certainty: repository.kind === "repository" ? "exact" : "partial",
			},
		],
		observations: configObservations,
	}
}

const KNOWN_NON_PUSH_GIT_COMMANDS = new Set([
	"add",
	"am",
	"apply",
	"archive",
	"bisect",
	"blame",
	"branch",
	"bundle",
	"checkout",
	"cherry",
	"cherry-pick",
	"clean",
	"clone",
	"commit",
	"config",
	"describe",
	"diff",
	"difftool",
	"fetch",
	"format-patch",
	"fsck",
	"gc",
	"grep",
	"init",
	"log",
	"merge",
	"mergetool",
	"mv",
	"notes",
	"pull",
	"range-diff",
	"rebase",
	"reflog",
	"remote",
	"reset",
	"restore",
	"revert",
	"rm",
	"show",
	"stash",
	"status",
	"submodule",
	"switch",
	"tag",
	"worktree",
])

export function analyzeStaticCommand(command: StaticCommand): CommandAnalysis {
	const resolved: string[] = []
	for (const word of command.argv) {
		if (word.kind !== "literal") return analyzePartiallyResolvedCommand(command)
		resolved.push(word.value)
	}
	return analyzeResolvedCommand({
		argv: resolved,
		cwd: command.cwd,
		repository: command.repository,
		githubRepository: command.githubRepository,
		gitRemotes: command.gitRemotes,
		gitDefaultBranch: command.gitDefaultBranch,
	})
}

function analyzePartiallyResolvedCommand(command: StaticCommand): CommandAnalysis {
	const executable = command.argv[0]
	if (executable?.kind !== "literal") {
		return { findings: [], observations: dynamicArgumentObservations(command.argv) }
	}
	const executableName = path.basename(executable.value)
	if (executableName !== "git" && executableName !== "gh") return { findings: [], observations: [] }
	if (executableName === "gh") return analyzePartiallyResolvedGitHub(command)
	const invocation = parseStaticGitInvocation(command.argv)
	if (!invocation || invocation.subcommand.kind !== "literal") {
		return { findings: [], observations: dynamicArgumentObservations(command.argv) }
	}
	let subcommand = invocation.subcommand.value
	let args = invocation.args
	if (subcommand === "send-pack") subcommand = "push"
	if (subcommand === "subtree") {
		const subtreePush = staticSubtreePushArgs(args)
		if (subtreePush) {
			subcommand = "push"
			args = subtreePush
		}
	}
	if (subcommand !== "push") return { findings: [], observations: dynamicArgumentObservations(command.argv) }
	if (args.some((arg) => arg.kind === "literal" && isPushDryRunOption(arg.value))) {
		return { findings: [], observations: dynamicArgumentObservations(command.argv) }
	}
	let force: GitPushEffect["details"]["force"] = "none"
	let deleteRefs = false
	let all = false
	let mirror = false
	let tags = false
	let prune = false
	const positional: StaticWord[] = []
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg?.kind === "literal" && arg.value === "--") {
			positional.push(...args.slice(index + 1))
			break
		}
		const forceOption = arg?.kind === "literal" ? pushForceKind(arg.value) : undefined
		const deleteOption = arg?.kind === "literal" ? isPushDeleteOption(arg.value) : false
		if (forceOption) force = forceOption
		if (deleteOption) deleteRefs = true
		if (forceOption || deleteOption) continue
		if (arg?.kind === "literal") {
			if (arg.value === "--all") all = true
			if (arg.value === "--mirror") mirror = true
			if (arg.value === "--tags") tags = true
			if (arg.value === "--prune") prune = true
			if (PUSH_FLAGS_WITH_VALUE.has(arg.value) && !arg.value.includes("=")) {
				index++
				continue
			}
			if (arg.value.startsWith("-")) continue
		}
		if (arg) positional.push(arg)
	}
	const [remote, ...explicitRefspecs] = positional
	const refspecs: readonly StaticWord[] =
		explicitRefspecs.length === 0 && command.gitDefaultBranch && !all && !mirror && !tags && !prune && !deleteRefs
			? [{ kind: "literal", value: command.gitDefaultBranch }]
			: explicitRefspecs
	if (refspecs.some((refspec) => refspec.kind === "literal" && refspec.value.startsWith("+"))) force = "force"
	const hasDeleteRefspec = refspecs.some((refspec) => refspec.kind === "literal" && refspec.value.startsWith(":"))
	const operation =
		deleteRefs || hasDeleteRefspec || mirror || prune
			? "git.push.delete"
			: force === "none"
				? "git.push"
				: "git.push.force"
	const displayArgv = command.argv.map(staticWordDisplay)
	const literalRemote = remote?.kind === "literal" ? remote.value : undefined
	const explicitRepository = literalRemote ? parseRepositoryUrl(literalRemote) : { kind: "unknown" as const }
	const configuredRemoteUrl =
		literalRemote && explicitRepository.kind === "unknown" ? command.gitRemotes?.get(literalRemote) : undefined
	const configuredRepository = configuredRemoteUrl
		? parseRepositoryUrl(configuredRemoteUrl)
		: { kind: "unknown" as const }
	const repository =
		explicitRepository.kind === "repository"
			? explicitRepository
			: configuredRepository.kind === "repository"
				? configuredRepository
				: (command.repository ?? { kind: "unknown" as const })
	const effect: GitPushEffect = {
		kind: "git-push",
		operation,
		remote:
			remote === undefined
				? { kind: "implicit" }
				: remote.kind === "composite"
					? { kind: "unknown", source: remote.source }
					: explicitRepository.kind === "repository"
						? { kind: "url", url: remote.value }
						: { kind: "named", name: remote.value },
		refspecs: refspecs.map((refspec) => {
			if (refspec.kind === "composite") return { kind: "unknown", source: refspec.source }
			if (deleteRefs) return { kind: "delete", destination: refspec.value }
			const normalized = refspec.value.startsWith("+") ? refspec.value.slice(1) : refspec.value
			const separator = normalized.indexOf(":")
			return separator < 0
				? { kind: "source", source: normalized }
				: { kind: "mapping", source: normalized.slice(0, separator), destination: normalized.slice(separator + 1) }
		}),
		repository,
		details: {
			force,
			destination: remote === undefined ? "implicit" : "explicit",
			all,
			mirror,
			tags,
			prune,
		},
	}
	return {
		findings: [{ effect, evidence: { analyzer: "git", argv: displayArgv }, certainty: "partial" }],
		observations: dynamicArgumentObservations(command.argv),
	}
}

function analyzePartiallyResolvedGitHub(command: StaticCommand): CommandAnalysis {
	const observations = dynamicArgumentObservations(command.argv)
	const graphqlIndex = command.argv.findIndex((word, index) => {
		const previous = command.argv[index - 1]
		return (
			word.kind === "literal" && word.value === "graphql" && previous?.kind === "literal" && previous.value === "api"
		)
	})
	if (graphqlIndex >= 0) {
		const dynamicQuery = command.argv
			.slice(graphqlIndex + 1)
			.find((word) => word.kind === "composite" && /^query=/.test(word.source))
		if (
			dynamicQuery?.kind === "composite" &&
			graphqlOperation(dynamicQuery.source.replace(/^query=["']?/, "")) !== "mutation"
		) {
			return {
				findings: [],
				observations: [...observations, { kind: "github-graphql-unknown", source: dynamicQuery.source }],
			}
		}
	}
	const approximate = analyzeResolvedCommand({
		argv: command.argv.map(staticWordDisplay),
		cwd: command.cwd,
		repository: command.repository,
		githubRepository: command.githubRepository,
		gitRemotes: command.gitRemotes,
		gitDefaultBranch: command.gitDefaultBranch,
	})
	if (approximate.findings.length > 0) {
		return {
			findings: approximate.findings.map((finding) => ({ ...finding, certainty: "partial" })),
			observations: [...observations, ...approximate.observations],
		}
	}
	let index = 1
	let host = "github.com"
	let target: GitHubTarget = command.githubRepository ?? command.repository ?? { kind: "unknown" }
	while (index < command.argv.length) {
		const arg = command.argv[index]
		if (arg?.kind !== "literal") return { findings: [], observations }
		if (arg.value === "--hostname" || arg.value === "-R" || arg.value === "--repo") {
			const value = command.argv[index + 1]
			if (value?.kind !== "literal") return { findings: [], observations }
			if (arg.value === "--hostname") host = value.value
			else target = parseGitHubTarget(value.value, host)
			index += 2
			continue
		}
		if (arg.value.startsWith("--hostname=")) {
			host = arg.value.slice("--hostname=".length)
			index++
			continue
		}
		if (arg.value.startsWith("--repo=")) {
			target = parseGitHubTarget(arg.value.slice("--repo=".length), host)
			index++
			continue
		}
		break
	}
	const groupWord = command.argv[index]
	const actionWord = command.argv[index + 1]
	const objectWord = command.argv[index + 2]
	if (groupWord?.kind !== "literal" || actionWord?.kind !== "literal") return { findings: [], observations }
	const operation = githubCommandOperation(groupWord.value, actionWord.value)
	if (!operation) return { findings: [], observations }
	const objectNumber = objectWord?.kind === "literal" ? objectWord.value : undefined
	const effect: GitHubEffect = {
		kind: "github",
		operation,
		target,
		details: githubCommandDetails(
			groupWord.value,
			actionWord.value,
			objectNumber,
			command.argv.slice(index + 2).map(staticWordDisplay),
		),
	}
	return {
		findings: [
			{
				effect,
				evidence: { analyzer: "github", argv: command.argv.map(staticWordDisplay) },
				certainty: "partial",
			},
		],
		observations,
	}
}

function dynamicArgumentObservations(argv: readonly StaticWord[]): CommandAnalysis["observations"] {
	return argv.flatMap((word, index) =>
		word.kind === "composite" ? [{ kind: "dynamic-argument" as const, source: word.source, index }] : [],
	)
}

function staticWordDisplay(word: StaticWord): string {
	return word.kind === "literal" ? word.value : word.source
}

function analyzeResolvedGitHubCommand(command: ResolvedCommand): CommandAnalysis {
	const apiAnalysis = analyzeResolvedGitHubApi(command)
	if (apiAnalysis) return apiAnalysis
	const invocation = parseGitHubInvocation(command.argv)
	if (!invocation) return { findings: [], observations: [] }
	const { group, action, objectNumber } = invocation
	const target =
		invocation.target.kind === "unknown"
			? (command.githubRepository ?? command.repository ?? invocation.target)
			: invocation.target
	const operation = githubCommandOperation(group, action)
	if (!operation) {
		return isReadOnlyGitHubCommand(group, action)
			? { findings: [], observations: [] }
			: { findings: [], observations: [{ kind: "unknown-github", argv: command.argv }] }
	}
	const effect: GitHubEffect = {
		kind: "github",
		operation,
		target,
		details: githubCommandDetails(group, action, objectNumber, invocation.arguments),
	}
	return {
		findings: [
			{
				effect,
				evidence: { analyzer: "github", argv: command.argv },
				certainty: target.kind === "repository" ? "exact" : "partial",
			},
		],
		observations: [],
	}
}

function githubCommandDetails(
	group: string,
	action: string,
	objectNumber: string | undefined,
	args: readonly string[],
): GitHubOperationDetails {
	if (group === "issue" || group === "pr") {
		return {
			object: {
				kind: group === "issue" ? "issue" : "pull-request",
				number: parseGitHubNumber(objectNumber),
			},
		}
	}
	return { command: { group, action, arguments: args } }
}

function analyzeResolvedGitHubApi(command: ResolvedCommand): CommandAnalysis | null {
	let apiIndex = 1
	let host = "github.com"
	let explicitTarget: GitHubTarget = { kind: "unknown" }
	while (apiIndex < command.argv.length) {
		const arg = command.argv[apiIndex]
		if (arg === "--hostname") {
			const value = command.argv[apiIndex + 1]
			if (!value) return null
			host = value
			apiIndex += 2
			continue
		}
		if (arg?.startsWith("--hostname=")) {
			host = arg.slice("--hostname=".length)
			apiIndex++
			continue
		}
		if (arg === "-R" || arg === "--repo") {
			const value = command.argv[apiIndex + 1]
			if (!value) return null
			explicitTarget = parseGitHubTarget(value, host)
			apiIndex += 2
			continue
		}
		if (arg?.startsWith("--repo=")) {
			explicitTarget = parseGitHubTarget(arg.slice("--repo=".length), host)
			apiIndex++
			continue
		}
		break
	}
	if (command.argv[apiIndex] !== "api") return null
	let method = "GET"
	let endpoint: string | undefined
	let hasFields = false
	let graphqlQuery: string | undefined
	let graphqlUnknownSource: string | undefined
	for (let index = apiIndex + 1; index < command.argv.length; index++) {
		const arg = command.argv[index]
		if (arg === "--method" || arg === "-X") {
			const value = command.argv[index + 1]
			if (value === undefined) return null
			method = value.toUpperCase()
			index++
			continue
		}
		if (arg?.startsWith("--method=")) {
			method = arg.slice("--method=".length).toUpperCase()
			continue
		}
		if (arg === "-f" || arg === "-F" || arg === "--field" || arg === "--raw-field" || arg === "--input") {
			hasFields = true
			const value = command.argv[index + 1]
			if (arg === "--input") graphqlUnknownSource = `${arg} ${value ?? ""}`.trim()
			else if (value?.startsWith("query=")) graphqlQuery = value.slice("query=".length)
			index++
			continue
		}
		if (arg?.startsWith("--field=") || arg?.startsWith("--raw-field=")) {
			hasFields = true
			const value = arg.slice(arg.indexOf("=") + 1)
			if (value.startsWith("query=")) graphqlQuery = value.slice("query=".length)
			continue
		}
		if (arg?.startsWith("--input=")) {
			hasFields = true
			graphqlUnknownSource = arg
			continue
		}
		if (!arg?.startsWith("-") && endpoint === undefined) endpoint = arg
	}
	if (hasFields && method === "GET") method = "POST"
	if (endpoint === "graphql" || endpoint === "/graphql") {
		if (graphqlQuery !== undefined) {
			const operation = graphqlOperation(graphqlQuery)
			if (operation === "read") return { findings: [], observations: [] }
			if (operation !== "mutation") {
				return { findings: [], observations: [{ kind: "github-graphql-unknown", source: graphqlQuery }] }
			}
		} else {
			return {
				findings: [],
				observations: [{ kind: "github-graphql-unknown", source: graphqlUnknownSource ?? "graphql input" }],
			}
		}
	}
	if (endpoint === undefined || method === "GET" || method === "HEAD") return { findings: [], observations: [] }
	const endpointTarget = parseGitHubApiTarget(endpoint, host)
	const target =
		endpointTarget.kind === "repository"
			? endpointTarget
			: explicitTarget.kind === "repository"
				? explicitTarget
				: (command.githubRepository ?? command.repository ?? endpointTarget)
	const effect: GitHubEffect = {
		kind: "github",
		operation: "gh.api.write",
		target,
		details: { api: { method, endpoint } },
	}
	return {
		findings: [
			{
				effect,
				evidence: { analyzer: "github", argv: command.argv },
				certainty: target.kind === "repository" ? "exact" : "partial",
			},
		],
		observations: [],
	}
}

function graphqlOperation(source: string): "mutation" | "read" | "unknown" {
	const withoutComments = source.replace(/#[^\r\n]*/g, " ").trim()
	if (/\bmutation\b/i.test(withoutComments)) return "mutation"
	return /^(?:query\b|\{)/i.test(withoutComments) ? "read" : "unknown"
}

function parseGitHubApiTarget(endpoint: string, host = "github.com"): GitHubTarget {
	const match = /^\/?repos\/([^/]+)\/([^/?#]+)/.exec(endpoint)
	return match?.[1] && match[2]
		? { kind: "repository", host, owner: match[1], repository: match[2] }
		: { kind: "unknown" }
}

type GitHubInvocation = {
	readonly group: string
	readonly action: string
	readonly objectNumber: string | undefined
	readonly arguments: readonly string[]
	readonly target: GitHubTarget
}

function parseGitHubInvocation(argv: readonly string[]): GitHubInvocation | null {
	const args: string[] = []
	let target: GitHubTarget = { kind: "unknown" }
	let host = "github.com"
	for (let index = 1; index < argv.length; index++) {
		const arg = argv[index]
		if (arg === "--hostname") {
			const value = argv[index + 1]
			if (value === undefined) return null
			host = value
			index++
			continue
		}
		if (arg?.startsWith("--hostname=")) {
			host = arg.slice("--hostname=".length)
			continue
		}
		if (arg === "-R" || arg === "--repo") {
			const value = argv[index + 1]
			if (value === undefined) return null
			target = parseGitHubTarget(value, host)
			index++
			continue
		}
		if (arg?.startsWith("--repo=")) {
			target = parseGitHubTarget(arg.slice("--repo=".length), host)
			continue
		}
		if (arg !== undefined) args.push(arg)
	}
	const [group, action, objectNumber] = args
	return group === undefined || action === undefined
		? null
		: { group, action, objectNumber, arguments: args.slice(2), target }
}

export function parseGitHubRepositoryTarget(input: string, defaultHost = "github.com"): GitHubTarget {
	return parseGitHubTarget(input, defaultHost)
}

function parseGitHubTarget(input: string, defaultHost = "github.com"): GitHubTarget {
	const parts = input.split("/")
	if (parts.length === 2) {
		const [owner, repository] = parts
		return owner && repository
			? { kind: "repository", host: defaultHost, owner, repository: repository.replace(/\.git$/, "") }
			: { kind: "unknown" }
	}
	if (parts.length === 3) {
		const [host, owner, repository] = parts
		return host && owner && repository
			? { kind: "repository", host, owner, repository: repository.replace(/\.git$/, "") }
			: { kind: "unknown" }
	}
	return { kind: "unknown" }
}

function parseGitHubNumber(input: string | undefined): number | undefined {
	if (input === undefined) return undefined
	const number = Number.parseInt(input, 10)
	return Number.isSafeInteger(number) && String(number) === input ? number : undefined
}

function pushForceKind(input: string): GitPushEffect["details"]["force"] | undefined {
	if (isCombinedPushFlag(input, "f") || input === "--force") return "force"
	if (input === "--force-with-lease" || input.startsWith("--force-with-lease=") || input === "--force-if-includes") {
		return "force-with-lease"
	}
	if (input.startsWith("--force-w") || input.startsWith("--force-i")) return "force-with-lease"
	return input.startsWith("--forc") ? "force" : undefined
}

function isPushDeleteOption(input: string): boolean {
	return input === "--delete" || isCombinedPushFlag(input, "d")
}

function isPushDryRunOption(input: string): boolean {
	return input === "--dry-run" || isCombinedPushFlag(input, "n")
}

function isCombinedPushFlag(input: string, flag: "d" | "f" | "n"): boolean {
	return /^-[dfnquv]+$/.test(input) && input.includes(flag)
}

function gitInvocationConfig(argv: readonly string[]): {
	readonly settings: readonly { readonly setting: string; readonly value: string }[]
	readonly aliases: ReadonlyMap<string, string>
	readonly hasUrlRewrite: boolean
} {
	const settings: { setting: string; value: string }[] = []
	for (let index = 1; index < argv.length; index++) {
		const argument = argv[index]
		let assignment: string | undefined
		if (argument === "-c") {
			assignment = argv[index + 1]
			index++
		} else if (argument?.startsWith("-c") && argument.length > 2) {
			assignment = argument.slice(2)
		}
		if (!assignment) continue
		const separator = assignment.indexOf("=")
		if (separator <= 0) continue
		const setting = assignment.slice(0, separator)
		const value = assignment.slice(separator + 1)
		if (/^alias\.[A-Za-z0-9._-]+$/i.test(setting) || /^url\..+\.(?:insteadOf|pushInsteadOf)$/i.test(setting)) {
			settings.push({ setting, value })
		}
	}
	const aliases = new Map<string, string>()
	let hasUrlRewrite = false
	for (const { setting, value } of settings) {
		if (/^alias\./i.test(setting)) aliases.set(setting.slice("alias.".length), value)
		else hasUrlRewrite = true
	}
	return { settings, aliases, hasUrlRewrite }
}

function plainGitAliasWords(input: string): readonly string[] | undefined {
	return /^[A-Za-z0-9._/:+@=-]+(?:\s+[A-Za-z0-9._/:+@=-]+)*$/.test(input) ? input.split(/\s+/) : undefined
}

function subtreePushArgs(args: readonly string[]): readonly string[] | undefined {
	const pushIndex = args.indexOf("push")
	if (pushIndex < 0) return undefined
	const output: string[] = []
	const candidates = [...args.slice(0, pushIndex), ...args.slice(pushIndex + 1)]
	for (let index = 0; index < candidates.length; index++) {
		const argument = candidates[index]
		if (argument === "--prefix" || argument === "-P") {
			index++
			continue
		}
		if (argument?.startsWith("--prefix=") || (argument?.startsWith("-P") && argument.length > 2)) continue
		if (argument !== undefined) output.push(argument)
	}
	return output
}

function parseStaticGitInvocation(
	argv: readonly StaticWord[],
): { readonly subcommand: StaticWord; readonly args: readonly StaticWord[] } | undefined {
	let index = 1
	while (index < argv.length) {
		const argument = argv[index]
		if (argument?.kind !== "literal") return undefined
		if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(argument.value)) {
			if (argv[index + 1] === undefined) return undefined
			index += 2
			continue
		}
		if (argument.value.startsWith("-")) {
			index++
			continue
		}
		return { subcommand: argument, args: argv.slice(index + 1) }
	}
	return undefined
}

function staticSubtreePushArgs(args: readonly StaticWord[]): readonly StaticWord[] | undefined {
	const pushIndex = args.findIndex((argument) => argument.kind === "literal" && argument.value === "push")
	if (pushIndex < 0) return undefined
	const output: StaticWord[] = []
	const candidates = [...args.slice(0, pushIndex), ...args.slice(pushIndex + 1)]
	for (let index = 0; index < candidates.length; index++) {
		const argument = candidates[index]
		if (argument?.kind === "literal" && (argument.value === "--prefix" || argument.value === "-P")) {
			index++
			continue
		}
		if (
			argument?.kind === "literal" &&
			(argument.value.startsWith("--prefix=") || (argument.value.startsWith("-P") && argument.value.length > 2))
		) {
			continue
		}
		if (argument) output.push(argument)
	}
	return output
}

function parseGitInvocation(
	argv: readonly string[],
): { readonly subcommand: string; readonly args: readonly string[] } | null {
	let index = 1
	while (index < argv.length) {
		const arg = argv[index]
		if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace") {
			if (argv[index + 1] === undefined) return null
			index += 2
			continue
		}
		if (
			arg?.startsWith("-C") ||
			arg?.startsWith("-c") ||
			arg?.startsWith("--git-dir=") ||
			arg?.startsWith("--work-tree=") ||
			arg?.startsWith("--namespace=")
		) {
			index++
			continue
		}
		break
	}
	const subcommand = argv[index]
	return subcommand === undefined ? null : { subcommand, args: argv.slice(index + 1) }
}

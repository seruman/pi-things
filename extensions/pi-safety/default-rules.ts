import * as path from "node:path"
import type { CanonicalPath, CanonicalPathError, SeatbeltPath } from "./canonical-path"
import { parseCanonicalPath, parseLexicalAbsolutePath, seatbeltPathAliases } from "./canonical-path"
import {
	type FilePolicy,
	type FilePolicyRule,
	type FileSelector,
	defineFilePolicy,
	excludeFromSnapshots,
	noAccess,
	pattern,
	readOnly,
	readWrite,
	readWriteForExecutable,
	tree,
} from "./file-policy"
import type { BashIntegrations } from "./integrations"
import { type PathPattern, type PathPatternError, parsePathPattern } from "./path-pattern"
import { type Result, err, ok } from "./result"
import {
	type PathMatcher,
	type Rule,
	allowFileExtensionIssues,
	allowIpNetwork,
	allowNetworkPath,
	allowPosixSharedMemoryRead,
	allowRuntimeOperations,
	allowSameSandbox,
	allowWebKitBrokerExtension,
	denyFileExtensionIssue,
	fileRule,
	globalMachService,
	literal,
	machLookupRule,
	pathPrefix,
	pathRegex,
	subpath,
	unixBindRule,
	unixConnectRule,
	unixSocketSubpath,
	xpcMachService,
} from "./sbpl"

const SNAPSHOT_EXCLUDED_COMPONENTS = [
	".git",
	".pi",
	".wb",
	"node_modules",
	"dist",
	"build",
	"target",
	".next",
	".cache",
	"coverage",
	"__pycache__",
	".pytest_cache",
] as const

export interface DefaultRulePaths {
	readonly workspace: CanonicalPath
	readonly home: CanonicalPath
	readonly stateHome: CanonicalPath
	readonly piConfigDirectory: CanonicalPath
}

export type DefaultRulesError =
	| { readonly kind: "fixed-path"; readonly path: string }
	| { readonly kind: "rule-path"; readonly path: string; readonly cause: CanonicalPathError }
	| {
			readonly kind: "pattern"
			readonly purpose: "access" | "snapshot"
			readonly input: string
			readonly cause: PathPatternError
	  }

export function createDefaultFilePolicy(input: {
	readonly paths: DefaultRulePaths
	readonly additionalNoAccessPatterns: readonly string[]
}): Result<FilePolicy, DefaultRulesError> {
	try {
		return createDefaultFilePolicyFromParsedRoots(input)
	} catch (cause) {
		if (cause instanceof DefaultRulePathFailure) return err(cause.error)
		throw cause
	}
}

function createDefaultFilePolicyFromParsedRoots(input: {
	readonly paths: DefaultRulePaths
	readonly additionalNoAccessPatterns: readonly string[]
}): Result<FilePolicy, DefaultRulesError> {
	const root = parseCanonicalPath("/")
	if (!root.ok) return err({ kind: "fixed-path", path: "/" })
	const sshDirectory = pathValue(input.paths.home, ".ssh")
	const snapshotStore = pathValue(input.paths.stateHome, "pi-safety", "snapshots")
	const parsed = parseDefaultPatterns(
		{ workspace: input.paths.workspace, sshDirectory, snapshotStore },
		input.additionalNoAccessPatterns,
	)
	if (!parsed.ok) return parsed
	const snapshotRules = createDefaultSnapshotRules(input.paths.workspace)
	if (!snapshotRules.ok) return snapshotRules

	const rules: FilePolicyRule[] = [
		readOnly(tree(root.value), { label: "read-only host" }),
		readWrite(tree(input.paths.workspace), { label: "project workspace" }),

		readOnly(tree(pathValue(input.paths.workspace, ".git", "hooks")), { label: "Git hooks" }),
		readOnly(tree(pathValue(input.paths.workspace, ".git", "config")), { label: "Git configuration" }),
		readOnly(tree(pathValue(input.paths.workspace, ".git", "config.worktree")), {
			label: "Git worktree configuration",
		}),
		readOnly(tree(pathValue(input.paths.workspace, ".pi")), { label: "Pi project configuration" }),
		readOnly(tree(pathValue(input.paths.workspace, ".mcp.json")), { label: "MCP configuration" }),
		readOnly(tree(pathValue(input.paths.workspace, ".claude")), { label: "Claude configuration" }),
		readOnly(tree(pathValue(input.paths.workspace, ".cursor", "rules")), { label: "Cursor rules" }),
		readOnly(tree(pathValue(input.paths.workspace, ".cursor", "mcp.json")), { label: "Cursor MCP configuration" }),
		readOnly(tree(pathValue(input.paths.workspace, ".github", "instructions")), { label: "GitHub instructions" }),
		readOnly(tree(pathValue(input.paths.workspace, ".github", "copilot-instructions.md")), {
			label: "Copilot instructions",
		}),
		readOnly(tree(pathValue(input.paths.workspace, ".vscode", "settings.json")), { label: "editor settings" }),
		readOnly(tree(pathValue(input.paths.workspace, ".vscode", "tasks.json")), { label: "editor tasks" }),
		readOnly(tree(pathValue(input.paths.workspace, ".vscode", "mcp.json")), { label: "editor MCP configuration" }),

		readOnly(tree(pathValue(input.paths.home, ".bashrc")), { label: "shell startup file" }),
		readOnly(tree(pathValue(input.paths.home, ".bash_profile")), { label: "shell startup file" }),
		readOnly(tree(pathValue(input.paths.home, ".profile")), { label: "shell startup file" }),
		readOnly(tree(pathValue(input.paths.home, ".zshrc")), { label: "shell startup file" }),
		readOnly(tree(pathValue(input.paths.home, ".zprofile")), { label: "shell startup file" }),
		readOnly(tree(pathValue(input.paths.home, ".gitconfig")), { label: "user Git configuration" }),
		readOnly(tree(pathValue(input.paths.home, ".config", "git", "config")), { label: "user Git configuration" }),
		readOnly(tree(pathValue(input.paths.home, ".config", "fish", "config.fish")), {
			label: "shell startup file",
		}),

		noAccess(tree(sshDirectory), { label: "private SSH material" }),
		...parsed.value.sshReadable.map((selector) => readOnly(pattern(selector), { label: "public SSH metadata" })),

		noAccess(tree(pathValue(input.paths.home, ".aws")), { label: "AWS credentials" }),
		noAccess(tree(pathValue(input.paths.home, ".cf")), { label: "Cloud Foundry credentials" }),
		noAccess(tree(pathValue(input.paths.piConfigDirectory, "auth.json")), { label: "Pi authentication" }),
		...parsed.value.noAccess.map((selector) => noAccess(pattern(selector))),
		...parsed.value.snapshotNoAccess.map((selector) => noAccess(pattern(selector), { label: "protected snapshot" })),

		...snapshotRules.value,
	]
	return ok(
		defineFilePolicy({
			workspaceRoot: input.paths.workspace,
			homeRoot: input.paths.home,
			rules,
		}),
	)
}

export function defaultRuntimeRules(input: {
	readonly policy: FilePolicy
	readonly integrations: BashIntegrations
}): readonly Rule[] {
	const devFd = fixedPath("/dev/fd")
	const devTtys = fixedPath("/dev/ttys")
	const devPty = fixedPath("/dev/pty")
	return Object.freeze([
		allowRuntimeOperations([
			"process-exec",
			"process-fork",
			"sysctl-read",
			"pseudo-tty",
			"system-socket",
			"appleevent-send",
			"lsopen",
		]),
		allowSameSandbox(["process-info*", "signal", "mach-priv-task-port"]),
		fileRule({
			effect: "allow",
			operations: ["file-write*"],
			matchers: [
				subpath(devFd),
				...["/dev/stdout", "/dev/stderr", "/dev/null", "/dev/tty", "/dev/ptmx"].map((pathname) =>
					literal(fixedPath(pathname)),
				),
				pathPrefix(devTtys),
				pathPrefix(devPty),
			],
		}),
		fileRule({
			effect: "allow",
			operations: ["file-ioctl"],
			matchers: [
				literal(fixedPath("/dev/tty")),
				literal(fixedPath("/dev/ptmx")),
				pathPrefix(devTtys),
				pathPrefix(devPty),
			],
		}),
		allowIpNetwork({ operation: "network-outbound", endpoint: "remote" }),
		allowNetworkPath(fixedPath("/private/var/run/mDNSResponder")),
		allowIpNetwork({ operation: "network-bind", endpoint: "local" }),
		allowIpNetwork({ operation: "network-inbound", endpoint: "local" }),
		machLookupRule({
			effect: "allow",
			services: [
				fixedGlobalService("com.apple.system.notification_center"),
				fixedGlobalService("com.apple.system.opendirectoryd.libinfo"),
				fixedGlobalService("com.apple.system.opendirectoryd.membership"),
				fixedGlobalService("com.apple.logd"),
				fixedGlobalService("com.apple.logd.events"),
				fixedGlobalService("com.apple.FSEvents"),
				fixedGlobalService("com.apple.SystemConfiguration.configd"),
				fixedGlobalService("com.apple.SystemConfiguration.DNSConfiguration"),
				fixedGlobalService("com.apple.trustd.agent"),
				fixedGlobalService("com.apple.diagnosticd"),
				fixedGlobalService("com.apple.dnssd.service"),
				fixedGlobalService("com.apple.CoreServices.coreservicesd"),
				fixedGlobalService("com.apple.coreservices.launchservicesd"),
				fixedGlobalService("com.apple.lsd.mapdb"),
				fixedGlobalService("com.apple.lsd.modifydb"),
				fixedGlobalService("com.apple.coreservices.quarantine-resolver"),
			],
		}),
		fixedPosixSharedMemoryRule("apple.shm.notification_center"),
		...defaultIntegrationRuntimeRules(input.integrations, input.policy),
	])
}

function defaultIntegrationRuntimeRules(integrations: BashIntegrations, policy: FilePolicy): readonly Rule[] {
	const rules: Rule[] = []
	for (const integration of [integrations.sshAgent, integrations.docker]) {
		if (integration.kind === "unix-socket") {
			rules.push(unixConnectRule({ effect: "allow", matchers: [unixSocketSubpath(integration.socket)] }))
		}
	}
	if (integrations.wb.kind === "enabled") rules.push(...defaultWbRuntimeRules(integrations.wb, policy))
	return rules
}

function defaultWbRuntimeRules(
	wb: Extract<BashIntegrations["wb"], { readonly kind: "enabled" }>,
	policy: FilePolicy,
): readonly Rule[] {
	const process = wb.executable
	const noAccessMatchers = policy.rules
		.filter(
			(rule): rule is Extract<FilePolicyRule, { readonly kind: "access" }> =>
				rule.kind === "access" && rule.executable === undefined && rule.access === "none",
		)
		.flatMap((rule) => matchersForSelector(rule.selector))
	const webKitReadRoots = [
		fixedPath("/private/tmp"),
		fixedPath("/nix/store"),
		fixedPath("/System"),
		fixedPath("/usr"),
		fixedPath("/Library"),
	] as const
	return [
		machLookupRule({
			effect: "allow",
			services: [
				fixedXpcService("com.apple.WebKit.GPU"),
				fixedXpcService("com.apple.WebKit.Networking"),
				fixedXpcService("com.apple.WebKit.WebContent"),
				fixedXpcService("com.apple.WebKit.WebContent.EnhancedSecurity"),
				fixedGlobalService("com.apple.nsurlsessiond"),
			],
			process,
		}),
		allowWebKitBrokerExtension("generic", process),
		allowWebKitBrokerExtension("iokit", process),
		allowWebKitBrokerExtension("mach", process),
		allowFileExtensionIssues({
			grants: [
				{
					extensionClass: "com.apple.app-sandbox.read",
					matchers: [
						...rootMatchers(policy.workspaceRoot),
						...webKitReadRoots.flatMap(rootMatchers),
						...rootMatchers(wb.webKitState),
						...rootMatchers(wb.cacheState),
					],
				},
				{
					extensionClass: "com.apple.app-sandbox.read-write",
					matchers: [
						...rootMatchers(policy.workspaceRoot),
						...policy.rules.filter(isUnscopedWritableTreeRule).flatMap((rule) => rootMatchers(rule.selector.path)),
						...rootMatchers(wb.runtimeDirectory),
						...seatbeltPathAliases(wb.runtimeDirectory).flatMap(rootMatchers),
						...rootMatchers(wb.webKitState),
						...rootMatchers(wb.cacheState),
					],
				},
			],
			process,
		}),
		unixConnectRule({ effect: "deny", matchers: [unixSocketSubpath(fixedPath("/"))], process }),
		unixBindRule({ effect: "deny", matchers: [unixSocketSubpath(fixedPath("/"))], process }),
		unixConnectRule({ effect: "allow", matchers: [unixSocketSubpath(wb.socket)], process }),
		unixBindRule({ effect: "allow", matchers: [unixSocketSubpath(wb.socket)], process }),
		...noAccessMatchers.flatMap((matcher) => [
			denyFileExtensionIssue({
				extensionClass: "com.apple.app-sandbox.read",
				matchers: [matcher],
				process,
			}),
			denyFileExtensionIssue({
				extensionClass: "com.apple.app-sandbox.read-write",
				matchers: [matcher],
				process,
			}),
		]),
	]
}

export function createSnapshotFilePolicy(workspace: CanonicalPath): Result<FilePolicy, DefaultRulesError> {
	const root = parseCanonicalPath("/")
	if (!root.ok) return err({ kind: "fixed-path", path: "/" })
	const snapshotRules = createDefaultSnapshotRules(workspace)
	if (!snapshotRules.ok) return snapshotRules
	return ok(
		defineFilePolicy({
			workspaceRoot: workspace,
			homeRoot: workspace,
			rules: [readOnly(tree(root.value)), readWrite(tree(workspace)), ...snapshotRules.value],
		}),
	)
}

export function createBashFilePolicy(input: {
	readonly base: FilePolicy
	readonly privateTemp: CanonicalPath
	readonly integrations: BashIntegrations
}): Result<FilePolicy, DefaultRulesError> {
	try {
		return ok(createBashFilePolicyFromParsedRoots(input))
	} catch (cause) {
		if (cause instanceof DefaultRulePathFailure) return err(cause.error)
		throw cause
	}
}

function createBashFilePolicyFromParsedRoots(input: {
	readonly base: FilePolicy
	readonly privateTemp: CanonicalPath
	readonly integrations: BashIntegrations
}): FilePolicy {
	const integrationRules: FilePolicyRule[] = [
		readWrite(tree(input.privateTemp), { label: "private temporary directory" }),
		readWriteForExecutable(
			input.integrations.gitExecutable,
			tree(pathValue(input.base.workspaceRoot, ".git", "hooks")),
			{ label: "Git-owned hooks" },
		),
		readWriteForExecutable(
			input.integrations.gitExecutable,
			tree(pathValue(input.base.workspaceRoot, ".git", "config")),
			{ label: "Git-owned configuration" },
		),
		readWriteForExecutable(
			input.integrations.gitExecutable,
			tree(pathValue(input.base.workspaceRoot, ".git", "config.worktree")),
			{ label: "Git-owned worktree configuration" },
		),
	]
	if (input.integrations.wb.kind === "enabled") {
		integrationRules.push(
			readWriteForExecutable(input.integrations.wb.executable, tree(input.integrations.wb.runtimeDirectory), {
				label: "wb runtime",
			}),
			readWriteForExecutable(input.integrations.wb.executable, tree(input.integrations.wb.webKitState), {
				label: "wb WebKit state",
			}),
			readWriteForExecutable(input.integrations.wb.executable, tree(input.integrations.wb.cacheState), {
				label: "wb cache",
			}),
		)
	}
	const terminalNoAccess = input.base.rules.filter(
		(rule): rule is Extract<FilePolicyRule, { readonly kind: "access" }> =>
			rule.kind === "access" && rule.access === "none" && rule.executable === undefined,
	)
	return defineFilePolicy({
		workspaceRoot: input.base.workspaceRoot,
		homeRoot: input.base.homeRoot,
		rules: [...input.base.rules, ...integrationRules, ...terminalNoAccess],
	})
}

type ParsedDefaultPatterns = {
	readonly noAccess: readonly PathPattern[]
	readonly sshReadable: readonly PathPattern[]
	readonly snapshotNoAccess: readonly PathPattern[]
}

function parseDefaultPatterns(
	paths: {
		readonly workspace: CanonicalPath
		readonly sshDirectory: CanonicalPath
		readonly snapshotStore: CanonicalPath
	},
	additionalNoAccessPatterns: readonly string[],
): Result<ParsedDefaultPatterns, DefaultRulesError> {
	const noAccess = parsePatterns(
		"access",
		[
			path.join(paths.workspace, "**", ".env"),
			path.join(paths.workspace, "**", ".env.*"),
			path.join(paths.workspace, "**", "*.env"),
			path.join(paths.workspace, "**", "*.env.*"),
			...additionalNoAccessPatterns,
		],
		paths.workspace,
	)
	if (!noAccess.ok) return noAccess
	const sshReadable = parsePatterns(
		"access",
		[
			path.join(paths.sshDirectory, "**", "*.pub"),
			path.join(paths.sshDirectory, "config"),
			path.join(paths.sshDirectory, "config.d"),
			path.join(paths.sshDirectory, "config.d", "**"),
			path.join(paths.sshDirectory, "known_hosts"),
			path.join(paths.sshDirectory, "known_hosts.old"),
			path.join(paths.sshDirectory, "allowed_signers"),
			path.join(paths.sshDirectory, "authorized_keys"),
		],
		paths.workspace,
	)
	if (!sshReadable.ok) return sshReadable
	const snapshotNoAccess = parsePatterns(
		"access",
		[
			path.join(paths.snapshotStore, "*", "*", "protected"),
			path.join(paths.snapshotStore, "*", "*", "protected", "**"),
		],
		paths.workspace,
	)
	if (!snapshotNoAccess.ok) return snapshotNoAccess
	return ok({
		noAccess: noAccess.value,
		sshReadable: sshReadable.value,
		snapshotNoAccess: snapshotNoAccess.value,
	})
}

function createDefaultSnapshotRules(workspace: CanonicalPath): Result<readonly FilePolicyRule[], DefaultRulesError> {
	const exclusions = parsePatterns("snapshot", snapshotExclusionInputs(workspace), workspace)
	if (!exclusions.ok) return exclusions
	return ok(
		Object.freeze(
			exclusions.value.map((selector) => excludeFromSnapshots(pattern(selector), { label: "snapshot exclusion" })),
		),
	)
}

function snapshotExclusionInputs(workspace: CanonicalPath): readonly string[] {
	return SNAPSHOT_EXCLUDED_COMPONENTS.flatMap((component) => [
		path.join(workspace, "**", component),
		path.join(workspace, "**", component, "**"),
	])
}

function parsePatterns(
	purpose: "access" | "snapshot",
	inputs: readonly string[],
	relativeTo: CanonicalPath,
): Result<readonly PathPattern[], DefaultRulesError> {
	const patterns: PathPattern[] = []
	for (const input of inputs) {
		const parsed = parsePathPattern(input, relativeTo)
		if (!parsed.ok) return err({ kind: "pattern", purpose, input, cause: parsed.error })
		patterns.push(parsed.value)
	}
	return ok(Object.freeze(patterns))
}

type AccessRule = Extract<FilePolicyRule, { readonly kind: "access" }>
type WritableTreeRule = AccessRule & {
	readonly executable?: undefined
	readonly access: "read-write"
	readonly selector: Extract<FileSelector, { readonly kind: "tree" }>
}

function isUnscopedWritableTreeRule(rule: FilePolicyRule): rule is WritableTreeRule {
	return (
		rule.kind === "access" &&
		rule.executable === undefined &&
		rule.access === "read-write" &&
		rule.selector.kind === "tree"
	)
}

function rootMatchers(root: SeatbeltPath): readonly [PathMatcher, PathMatcher] {
	return [literal(root), subpath(root)]
}

function matchersForSelector(selector: FileSelector): readonly PathMatcher[] {
	return selector.kind === "file"
		? [literal(selector.path)]
		: selector.kind === "tree"
			? [literal(selector.path), subpath(selector.path)]
			: [pathRegex(selector.pattern.regex)]
}

function fixedPath(input: string): SeatbeltPath {
	const parsed = parseLexicalAbsolutePath(input)
	if (!parsed.ok) throw new TypeError(`failed to parse fixed default path: ${input}`)
	return parsed.value
}

function fixedXpcService(input: string) {
	const parsed = xpcMachService(input)
	if (!parsed.ok) throw new TypeError(`failed to parse fixed XPC service: ${input}`)
	return parsed.value
}

function fixedGlobalService(input: string) {
	const parsed = globalMachService(input)
	if (!parsed.ok) throw new TypeError(`failed to parse fixed Mach service: ${input}`)
	return parsed.value
}

function fixedPosixSharedMemoryRule(input: string): Rule {
	const parsed = allowPosixSharedMemoryRead(input)
	if (!parsed.ok) throw new TypeError(`failed to parse fixed POSIX shared memory name: ${input}`)
	return parsed.value
}

class DefaultRulePathFailure extends Error {
	readonly error: Extract<DefaultRulesError, { readonly kind: "rule-path" }>

	constructor(pathname: string, cause: CanonicalPathError) {
		super(`failed to construct default rule path: ${pathname}`)
		this.error = { kind: "rule-path", path: pathname, cause }
	}
}

function pathValue(root: CanonicalPath, ...components: string[]): CanonicalPath {
	const pathname = path.join(root, ...components)
	const parsed = parseCanonicalPath(pathname)
	if (!parsed.ok) throw new DefaultRulePathFailure(pathname, parsed.error)
	return parsed.value
}

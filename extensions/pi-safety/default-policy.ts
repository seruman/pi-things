import * as path from "node:path"
import type { CanonicalPath, CanonicalPathError, SeatbeltPath } from "./canonical-path"
import { parseCanonicalPath, parseLexicalAbsolutePath, seatbeltPathAliases } from "./canonical-path"
import type { BashIntegrations } from "./integrations"
import { type PathPattern, type PathPatternError, parsePathPattern } from "./path-pattern"
import {
	type FileAccessRule,
	type FileSelector,
	type PathMatcher,
	type Policy,
	type PolicyRule,
	type RuntimePolicyRule,
	allowFileExtensionIssues,
	allowIpNetwork,
	allowNetworkPath,
	allowPosixSharedMemoryRead,
	allowRuntimeOperations,
	allowSameSandbox,
	allowWebKitBrokerExtension,
	definePolicy,
	denyFileExtensionIssue,
	excludeFromSnapshots,
	executable,
	fileRule,
	literal,
	noAccess,
	pathPrefix,
	pathRegex,
	pattern,
	readOnly,
	readWrite,
	sandbox,
	seatbeltFile,
	seatbeltPrefix,
	seatbeltTree,
	shared,
	subpath,
	tree,
	unixBindRule,
	unixConnectRule,
	unixSocketPath,
	unixSocketSubpath,
} from "./policy"
import { type Result, err, ok } from "./result"
import type { SessionPathGrant } from "./session-paths"

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

export interface DefaultPolicyPaths {
	readonly workspace: CanonicalPath
	readonly home: CanonicalPath
	readonly stateHome: CanonicalPath
	readonly piConfigDirectory: CanonicalPath
}

export type DefaultPolicyError =
	| { readonly kind: "fixed-path"; readonly path: string }
	| { readonly kind: "rule-path"; readonly path: string; readonly cause: CanonicalPathError }
	| {
			readonly kind: "pattern"
			readonly purpose: "access" | "snapshot"
			readonly input: string
			readonly cause: PathPatternError
	  }

export function createDefaultPolicy(input: {
	readonly paths: DefaultPolicyPaths
	readonly additionalNoAccessPatterns: readonly string[]
	readonly goPaths?: readonly CanonicalPath[]
	readonly sessionPaths?: readonly SessionPathGrant[]
	readonly sandbox:
		| { readonly kind: "disabled" }
		| { readonly kind: "enabled"; readonly privateTemp: CanonicalPath; readonly integrations: BashIntegrations }
}): Result<Policy, DefaultPolicyError> {
	try {
		return createDefaultPolicyFromParsedRoots(input)
	} catch (cause) {
		if (cause instanceof DefaultPolicyPathFailure) return err(cause.error)
		throw cause
	}
}

/**
 * The default policy is assembled below in its exact evaluation order.
 * File and snapshot rules are last-match-wins. Runtime rules follow them.
 */
function createDefaultPolicyFromParsedRoots(input: {
	readonly paths: DefaultPolicyPaths
	readonly additionalNoAccessPatterns: readonly string[]
	readonly goPaths?: readonly CanonicalPath[]
	readonly sessionPaths?: readonly SessionPathGrant[]
	readonly sandbox:
		| { readonly kind: "disabled" }
		| { readonly kind: "enabled"; readonly privateTemp: CanonicalPath; readonly integrations: BashIntegrations }
}): Result<Policy, DefaultPolicyError> {
	const root = parseCanonicalPath("/")
	if (!root.ok) return err({ kind: "fixed-path", path: "/" })
	const sshDirectory = pathValue(input.paths.home, ".ssh")
	const snapshotStore = pathValue(input.paths.stateHome, "pi-safety", "snapshots")
	const rules: PolicyRule[] = []

	// Host and workspace.
	const sessionPaths = input.sessionPaths ?? []
	rules.push(
		readOnly(shared(), tree(root.value)),
		...sessionPaths
			.filter((grant) => grant.access === "read-only")
			.map((grant) => readOnly(shared(), tree(grant.path))),
		readWrite(shared(), tree(input.paths.workspace)),
		...sessionPaths
			.filter((grant) => grant.access === "read-write")
			.map((grant) => readWrite(shared(), tree(grant.path))),
	)

	// Project configuration is readable but only its owning integration may change it.
	rules.push(
		readOnly(shared(), tree(pathValue(input.paths.workspace, ".git", "hooks"))),
		readOnly(shared(), tree(pathValue(input.paths.workspace, ".git", "config"))),
		readOnly(shared(), tree(pathValue(input.paths.workspace, ".git", "config.worktree"))),
		readOnly(shared(), tree(pathValue(input.paths.workspace, ".pi"))),
		readOnly(shared(), tree(pathValue(input.paths.workspace, ".mcp.json"))),
		readOnly(shared(), tree(pathValue(input.paths.workspace, ".claude"))),
		readOnly(shared(), tree(pathValue(input.paths.workspace, ".cursor", "rules"))),
		readOnly(shared(), tree(pathValue(input.paths.workspace, ".cursor", "mcp.json"))),
		readOnly(shared(), tree(pathValue(input.paths.workspace, ".github", "instructions"))),
		readOnly(shared(), tree(pathValue(input.paths.workspace, ".github", "copilot-instructions.md"))),
		readOnly(shared(), tree(pathValue(input.paths.workspace, ".vscode", "settings.json"))),
		readOnly(shared(), tree(pathValue(input.paths.workspace, ".vscode", "tasks.json"))),
		readOnly(shared(), tree(pathValue(input.paths.workspace, ".vscode", "mcp.json"))),
	)

	// User configuration is readable but immutable.
	rules.push(
		readOnly(shared(), tree(pathValue(input.paths.home, ".bashrc"))),
		readOnly(shared(), tree(pathValue(input.paths.home, ".bash_profile"))),
		readOnly(shared(), tree(pathValue(input.paths.home, ".profile"))),
		readOnly(shared(), tree(pathValue(input.paths.home, ".zshrc"))),
		readOnly(shared(), tree(pathValue(input.paths.home, ".zprofile"))),
		readOnly(shared(), tree(pathValue(input.paths.home, ".gitconfig"))),
		readOnly(shared(), tree(pathValue(input.paths.home, ".config", "git", "config"))),
		readOnly(shared(), tree(pathValue(input.paths.home, ".config", "fish", "config.fish"))),
	)

	// Standard tool caches and runtime state are writable for both Bash and built-in tools.
	rules.push(
		readWrite(shared(), tree(pathValue(input.paths.home, ".cache"))),
		readWrite(shared(), tree(pathValue(input.paths.home, "Library", "Caches"))),
		readWrite(shared(), tree(pathValue(input.paths.home, ".npm"))),
		readWrite(shared(), tree(pathValue(input.paths.home, ".bun", "install", "cache"))),
		readWrite(shared(), tree(pathValue(input.paths.home, ".cargo"))),
		...(input.goPaths ?? [pathValue(input.paths.home, "go")]).map((goPath) =>
			readWrite(shared(), tree(pathValue(goPath, "pkg"))),
		),
		readWrite(shared(), tree(pathValue(input.paths.home, ".xdg"))),
		// Preserve ordinary macOS Keychain workflows; item ACLs still authorize individual credentials.
		readWrite(shared(), tree(pathValue(input.paths.home, "Library", "Keychains"))),
	)

	// Sandbox and executable-specific filesystem capabilities.
	if (input.sandbox.kind === "enabled") {
		const integrations = input.sandbox.integrations
		rules.push(
			readWrite(shared(), tree(temporaryContainer(input.sandbox.privateTemp))),
			readWrite(shared(), seatbeltTree(fixedPath("/private/tmp"))),
			readWrite(sandbox(), seatbeltTree(fixedPath("/dev/fd"))),
			...["/dev/stdout", "/dev/stderr", "/dev/null", "/dev/tty", "/dev/ptmx"].map((pathname) =>
				readWrite(sandbox(), seatbeltFile(fixedPath(pathname))),
			),
			readWrite(sandbox(), seatbeltPrefix(fixedPath("/dev/ttys"))),
			readWrite(sandbox(), seatbeltPrefix(fixedPath("/dev/pty"))),
			readWrite(executable(integrations.gitExecutable), tree(pathValue(input.paths.workspace, ".git", "hooks"))),
			readWrite(executable(integrations.gitExecutable), tree(pathValue(input.paths.workspace, ".git", "config"))),
			readWrite(
				executable(integrations.gitExecutable),
				tree(pathValue(input.paths.workspace, ".git", "config.worktree")),
			),
		)
		if (integrations.nix.kind === "enabled") {
			rules.push(readWrite(executable(integrations.nix.executable), tree(integrations.nix.cacheDirectory)))
		}
		if (integrations.wb.kind === "enabled") {
			rules.push(
				readWrite(executable(integrations.wb.executable), tree(integrations.wb.runtimeDirectory)),
				readWrite(executable(integrations.wb.executable), tree(integrations.wb.webKitState)),
				readWrite(executable(integrations.wb.executable), tree(integrations.wb.cacheState)),
			)
		}
	}

	// Credentials and sensitive host state. Later exceptions are intentional.
	rules.push(noAccess(shared(), tree(sshDirectory)))
	const sshReadable = parsePatterns(
		"access",
		[
			path.join(sshDirectory, "**", "*.pub"),
			path.join(sshDirectory, "config"),
			path.join(sshDirectory, "config.d"),
			path.join(sshDirectory, "config.d", "**"),
			path.join(sshDirectory, "known_hosts"),
			path.join(sshDirectory, "known_hosts.old"),
			path.join(sshDirectory, "allowed_signers"),
			path.join(sshDirectory, "authorized_keys"),
		],
		input.paths.workspace,
	)
	if (!sshReadable.ok) return sshReadable
	rules.push(
		...sshReadable.value.map((selector) => readOnly(shared(), pattern(selector))),
		noAccess(shared(), tree(pathValue(input.paths.home, ".env"))),
		noAccess(shared(), tree(pathValue(input.paths.home, ".netrc"))),
		noAccess(shared(), tree(pathValue(input.paths.home, ".gitcookies"))),
		noAccess(shared(), tree(pathValue(input.paths.home, ".config", "opnix"))),
		noAccess(shared(), tree(pathValue(input.paths.home, ".aws"))),
		noAccess(shared(), tree(pathValue(input.paths.home, ".cf"))),
		noAccess(shared(), tree(pathValue(input.paths.piConfigDirectory, "auth.json"))),
	)

	// Project secret conventions and project-specific tighten-only rules.
	const projectSecrets = parsePatterns(
		"access",
		[
			path.join(input.paths.workspace, "**", ".env"),
			path.join(input.paths.workspace, "**", ".env.*"),
			path.join(input.paths.workspace, "**", "*.env"),
			path.join(input.paths.workspace, "**", "*.env.*"),
			...input.additionalNoAccessPatterns,
		],
		input.paths.workspace,
	)
	if (!projectSecrets.ok) return projectSecrets
	rules.push(...projectSecrets.value.map((selector) => noAccess(shared(), pattern(selector))))

	// Snapshot protected storage is never exposed through a live workspace policy.
	const protectedSnapshots = parsePatterns(
		"access",
		[path.join(snapshotStore, "*", "*", "protected"), path.join(snapshotStore, "*", "*", "protected", "**")],
		input.paths.workspace,
	)
	if (!protectedSnapshots.ok) return protectedSnapshots
	rules.push(...protectedSnapshots.value.map((selector) => noAccess(shared(), pattern(selector))))

	// Snapshot inclusion is an independent last-match-wins policy axis.
	const snapshotExclusions = parseSnapshotExclusions(input.paths.workspace)
	if (!snapshotExclusions.ok) return snapshotExclusions
	rules.push(...snapshotExclusions.value.map((selector) => excludeFromSnapshots(pattern(selector))))

	// Seatbelt runtime capabilities. These do not apply to built-in file requests.
	if (input.sandbox.kind === "enabled") {
		const integrations = input.sandbox.integrations
		const devTtys = fixedPath("/dev/ttys")
		const devPty = fixedPath("/dev/pty")
		rules.push(
			allowRuntimeOperations([
				"process-exec",
				"process-fork",
				"sysctl-read",
				"pseudo-tty",
				"system-socket",
				"appleevent-send",
				"lsopen",
				"mach-lookup",
			]),
			allowSameSandbox(["process-info*", "signal", "mach-priv-task-port"]),
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
			fixedPosixSharedMemoryRule("apple.shm.notification_center"),
		)

		// Discovered SSH-agent and Docker sockets are exact capabilities.
		for (const integration of [integrations.sshAgent, integrations.docker]) {
			if (integration.kind === "unix-socket") {
				rules.push(unixConnectRule({ effect: "allow", matchers: [unixSocketPath(integration.socket)] }))
			}
		}
		if (integrations.nix.kind === "enabled" && integrations.nix.daemon.kind === "unix-socket") {
			rules.push(
				unixConnectRule({
					effect: "allow",
					matchers: [unixSocketPath(integrations.nix.daemon.socket)],
					process: integrations.nix.executable,
				}),
			)
		}

		// Native wb and its WebKit children receive only wb-scoped capabilities.
		if (integrations.wb.kind === "enabled") {
			const wb = integrations.wb
			const process = wb.executable
			const noAccessMatchers = rules
				.filter(
					(rule): rule is FileAccessRule =>
						rule.kind === "file-access" && rule.subject.kind === "shared" && rule.access === "none",
				)
				.flatMap((rule) => matchersForSelector(rule.selector))
			const webKitReadRoots = [
				fixedPath("/private/tmp"),
				fixedPath("/nix/store"),
				fixedPath("/System"),
				fixedPath("/usr"),
				fixedPath("/Library"),
			] as const
			rules.push(
				allowWebKitBrokerExtension("generic", process),
				allowWebKitBrokerExtension("iokit", process),
				allowWebKitBrokerExtension("mach", process),
				allowFileExtensionIssues({
					grants: [
						{
							extensionClass: "com.apple.app-sandbox.read",
							matchers: [
								...rootMatchers(input.paths.workspace),
								...webKitReadRoots.flatMap(rootMatchers),
								...rootMatchers(wb.webKitState),
								...rootMatchers(wb.cacheState),
							],
						},
						{
							extensionClass: "com.apple.app-sandbox.read-write",
							matchers: [
								...rootMatchers(input.paths.workspace),
								...rules.filter(isSharedWritableTreeRule).flatMap((rule) => rootMatchers(rule.selector.path)),
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
				unixConnectRule({ effect: "allow", matchers: [unixSocketPath(wb.socket)], process }),
				unixBindRule({ effect: "allow", matchers: [unixSocketPath(wb.socket)], process }),
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
			)
		}
	}

	return ok(
		definePolicy({
			workspaceRoot: input.paths.workspace,
			homeRoot: input.paths.home,
			rules,
		}),
	)
}

export function createSnapshotPolicy(workspace: CanonicalPath): Result<Policy, DefaultPolicyError> {
	const root = parseCanonicalPath("/")
	if (!root.ok) return err({ kind: "fixed-path", path: "/" })
	const snapshotExclusions = parseSnapshotExclusions(workspace)
	if (!snapshotExclusions.ok) return snapshotExclusions
	return ok(
		definePolicy({
			workspaceRoot: workspace,
			homeRoot: workspace,
			rules: [
				readOnly(shared(), tree(root.value)),
				readWrite(shared(), tree(workspace)),
				...snapshotExclusions.value.map((selector) => excludeFromSnapshots(pattern(selector))),
			],
		}),
	)
}

function parseSnapshotExclusions(workspace: CanonicalPath): Result<readonly PathPattern[], DefaultPolicyError> {
	return parsePatterns(
		"snapshot",
		SNAPSHOT_EXCLUDED_COMPONENTS.flatMap((component) => [
			path.join(workspace, "**", component),
			path.join(workspace, "**", component, "**"),
		]),
		workspace,
	)
}

function parsePatterns(
	purpose: "access" | "snapshot",
	inputs: readonly string[],
	relativeTo: CanonicalPath,
): Result<readonly PathPattern[], DefaultPolicyError> {
	const patterns: PathPattern[] = []
	for (const input of inputs) {
		const parsed = parsePathPattern(input, relativeTo)
		if (!parsed.ok) return err({ kind: "pattern", purpose, input, cause: parsed.error })
		patterns.push(parsed.value)
	}
	return ok(Object.freeze(patterns))
}

type WritableTreeRule = FileAccessRule & {
	readonly subject: Extract<FileAccessRule["subject"], { readonly kind: "shared" }>
	readonly access: "read-write"
	readonly selector: Extract<FileSelector, { readonly kind: "tree" }>
}

function isSharedWritableTreeRule(rule: PolicyRule): rule is WritableTreeRule {
	return (
		rule.kind === "file-access" &&
		rule.subject.kind === "shared" &&
		rule.access === "read-write" &&
		rule.selector.kind === "tree"
	)
}

function rootMatchers(root: SeatbeltPath): readonly [PathMatcher, PathMatcher] {
	return [literal(root), subpath(root)]
}

function matchersForSelector(selector: FileSelector): readonly PathMatcher[] {
	switch (selector.kind) {
		case "file":
		case "seatbelt-file":
			return [literal(selector.path)]
		case "tree":
		case "seatbelt-tree":
			return [literal(selector.path), subpath(selector.path)]
		case "seatbelt-prefix":
			return [pathPrefix(selector.path)]
		case "glob":
			return [pathRegex(selector.pattern.regex)]
		default:
			return selector satisfies never
	}
}

function fixedPath(input: string): SeatbeltPath {
	const parsed = parseLexicalAbsolutePath(input)
	if (!parsed.ok) throw new TypeError(`failed to parse fixed default path: ${input}`)
	return parsed.value
}

function fixedPosixSharedMemoryRule(input: string): RuntimePolicyRule {
	const parsed = allowPosixSharedMemoryRead(input)
	if (!parsed.ok) throw new TypeError(`failed to parse fixed POSIX shared memory name: ${input}`)
	return parsed.value
}

class DefaultPolicyPathFailure extends Error {
	readonly error: Extract<DefaultPolicyError, { readonly kind: "rule-path" }>

	constructor(pathname: string, cause: CanonicalPathError) {
		super(`failed to construct default rule path: ${pathname}`)
		this.error = { kind: "rule-path", path: pathname, cause }
	}
}

function temporaryContainer(privateTemp: CanonicalPath): CanonicalPath {
	if (path.basename(privateTemp) !== "T") return privateTemp
	const container = path.dirname(privateTemp)
	const parsed = parseCanonicalPath(container)
	if (!parsed.ok) throw new DefaultPolicyPathFailure(container, parsed.error)
	return parsed.value
}

function pathValue(root: CanonicalPath, ...components: string[]): CanonicalPath {
	const pathname = path.join(root, ...components)
	const parsed = parseCanonicalPath(pathname)
	if (!parsed.ok) throw new DefaultPolicyPathFailure(pathname, parsed.error)
	return parsed.value
}

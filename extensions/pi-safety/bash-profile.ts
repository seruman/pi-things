import { type CanonicalPath, type SeatbeltPath, parseCanonicalPath, seatbeltPathAliases } from "./canonical-path"
import type { BashIntegrations, WbIntegration } from "./integrations"
import { movementProtectionRulePhases } from "./move-protection"
import { type ProtectedPathPattern, literalProtectedPath } from "./protected-path"
import {
	type CompiledSbpl,
	type PathMatcher,
	type Rule,
	allowFileExtensionIssues,
	allowWebKitBrokerExtension,
	denyFileExtensionIssue,
	emitSbpl,
	fileRule,
	fileRuleExceptProcess,
	globalMachService,
	literal,
	machLookupRule,
	pathRegex,
	subpath,
	unixBindRule,
	unixConnectRule,
	unixSocketSubpath,
	xpcMachService,
} from "./sbpl"
import type { BuiltinAccessPolicy } from "./tool-authorization"

const ROOT_PATH = canonicalFixedPath("/")
const WEBKIT_READ_ROOTS = [
	canonicalFixedPath("/private/tmp"),
	canonicalFixedPath("/nix/store"),
	canonicalFixedPath("/System"),
	canonicalFixedPath("/usr"),
	canonicalFixedPath("/Library"),
] as const

const BASE_PROFILE = `(version 1)
(deny default)

;; Read-only host view. Terminal rules below remove secret content.
(allow file-read*)

;; Normal subprocess trees and runtime introspection.
(allow process-exec)
(allow process-fork)
(allow sysctl-read)
(allow process-info* (target same-sandbox))
(allow signal (target same-sandbox))
(allow mach-priv-task-port (target same-sandbox))
(allow pseudo-tty)

;; Standard streams, terminals, entropy, and descriptor plumbing.
(allow file-write*
  (subpath "/dev/fd")
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (literal "/dev/null")
  (literal "/dev/tty")
  (literal "/dev/ptmx")
  (regex #"^/dev/ttys")
  (regex #"^/dev/pty"))
(allow file-ioctl
  (literal "/dev/tty")
  (literal "/dev/ptmx")
  (regex #"^/dev/ttys")
  (regex #"^/dev/pty"))

;; TCP/UDP networking and local development servers.
(allow network-outbound (remote ip))
(allow network-outbound (literal "/private/var/run/mDNSResponder"))
(allow network-bind (local ip))
(allow network-inbound (local ip))
(allow system-socket)

;; Baseline macOS services used by shells, runtimes, DNS, TLS, and file watchers.
(allow mach-lookup
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.logd")
  (global-name "com.apple.logd.events")
  (global-name "com.apple.FSEvents")
  (global-name "com.apple.SystemConfiguration.configd")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.diagnosticd")
  (global-name "com.apple.dnssd.service")
  (global-name "com.apple.CoreServices.coreservicesd")
  (global-name "com.apple.coreservices.launchservicesd")
  (global-name "com.apple.lsd.mapdb")
  (global-name "com.apple.lsd.modifydb")
  (global-name "com.apple.coreservices.quarantine-resolver"))
(allow ipc-posix-shm-read-data (ipc-posix-name "apple.shm.notification_center"))

;; Deliberate ergonomic escape hatch for open(1) and GUI automation.
(allow appleevent-send)
(allow lsopen)
`

export function compileBashProfile(input: {
	readonly policy: BuiltinAccessPolicy
	readonly privateTemp: CanonicalPath
	readonly integrations: BashIntegrations
}): CompiledSbpl {
	const writeRoots = [input.policy.workspaceRoot, input.privateTemp] as const
	const secretPatterns = [...input.policy.secretPatterns, literalProtectedPath(input.policy.ssh.protectedRoot)]
	const nonGitProtectedWrites = input.policy.protectedWritePatterns.filter(
		(pattern) => !input.policy.gitWritePatterns.includes(pattern),
	)
	const terminalPatterns = [
		...secretPatterns,
		...nonGitProtectedWrites,
		...input.policy.protectedSnapshotPatterns,
		...input.policy.immutableWriteRoots.map(literalProtectedPath),
	]
	const movementPhases = [
		movementProtectionRulePhases({
			scope: { kind: "sandbox" },
			broadDenied: terminalPatterns,
			writableRoots: writeRoots,
			terminalDenied: terminalPatterns,
		}),
		movementProtectionRulePhases({
			scope: { kind: "except-process", executable: input.integrations.gitExecutable },
			broadDenied: input.policy.gitWritePatterns,
			writableRoots: writeRoots,
			terminalDenied: input.policy.gitWritePatterns,
		}),
	]
	const rules: Rule[] = [
		...integrationRules(input.integrations, input.policy, input.privateTemp),
		...writeRoots.map((root) =>
			fileRule({
				effect: "allow",
				operations: ["file-write*"],
				matchers: [subpath(root), ...seatbeltPathAliases(root).map(subpath)],
			}),
		),
		...movementPhases.flatMap((phases) => phases.broadDenials),
		...movementPhases.flatMap((phases) => phases.writableRootAllows),
		...movementPhases.flatMap((phases) => phases.terminalDenials),
		...denyReadRules(input.policy.secretPatterns),
		fileRule({
			effect: "deny",
			operations: ["file-read*"],
			matchers: [subpath(input.policy.ssh.protectedRoot)],
		}),
		...allowReadRules(input.policy.ssh.readableMetadata),
		...denyReadRules(input.policy.protectedSnapshotPatterns),
		...denyWriteRules(terminalPatterns),
		...denyWriteRulesExceptProcess(input.policy.gitWritePatterns, input.integrations.gitExecutable),
	]
	const dynamic = emitSbpl(rules)
	return Object.freeze({
		source: `${BASE_PROFILE}${dynamic.source}\n`,
		parameters: dynamic.parameters,
	})
}

function integrationRules(
	integrations: BashIntegrations,
	policy: BuiltinAccessPolicy,
	privateTemp: CanonicalPath,
): Rule[] {
	const rules: Rule[] = []
	for (const integration of [integrations.sshAgent, integrations.docker]) {
		if (integration.kind === "unix-socket") {
			rules.push(unixConnectRule({ effect: "allow", matchers: [unixSocketSubpath(integration.socket)] }))
		}
	}
	if (integrations.wb.kind === "enabled") rules.push(...wbRules(integrations.wb, policy, privateTemp))
	return rules
}

function wbRules(
	wb: Extract<WbIntegration, { kind: "enabled" }>,
	policy: BuiltinAccessPolicy,
	privateTemp: CanonicalPath,
): Rule[] {
	const process = wb.executable
	const protectedMatchers = [
		...policy.secretPatterns.map(matcherForPattern),
		subpath(policy.ssh.protectedRoot),
		...policy.protectedSnapshotPatterns.map(matcherForPattern),
	]
	return [
		fileRule({
			effect: "allow",
			operations: ["file-write*"],
			matchers: [
				...rootMatchers(wb.runtimeDirectory),
				...seatbeltPathAliases(wb.runtimeDirectory).flatMap(rootMatchers),
				subpath(wb.webKitState),
				subpath(wb.cacheState),
			],
			process,
		}),
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
						...WEBKIT_READ_ROOTS.flatMap(rootMatchers),
						...rootMatchers(wb.webKitState),
						...rootMatchers(wb.cacheState),
					],
				},
				{
					extensionClass: "com.apple.app-sandbox.read-write",
					matchers: [
						...rootMatchers(policy.workspaceRoot),
						...rootMatchers(privateTemp),
						...rootMatchers(wb.runtimeDirectory),
						...seatbeltPathAliases(wb.runtimeDirectory).flatMap(rootMatchers),
						...rootMatchers(wb.webKitState),
						...rootMatchers(wb.cacheState),
					],
				},
			],
			process,
		}),
		unixConnectRule({ effect: "deny", matchers: [unixSocketSubpath(ROOT_PATH)], process }),
		unixBindRule({ effect: "deny", matchers: [unixSocketSubpath(ROOT_PATH)], process }),
		unixConnectRule({ effect: "allow", matchers: [unixSocketSubpath(wb.socket)], process }),
		unixBindRule({ effect: "allow", matchers: [unixSocketSubpath(wb.socket)], process }),
		...protectedMatchers.flatMap((matcher) => [
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

function rootMatchers(root: SeatbeltPath): readonly [PathMatcher, PathMatcher] {
	return [literal(root), subpath(root)]
}

function fixedGlobalService(name: string) {
	const parsed = globalMachService(name)
	if (!parsed.ok) throw new TypeError(`invalid fixed global Mach service: ${name}`)
	return parsed.value
}

function fixedXpcService(name: string) {
	const parsed = xpcMachService(name)
	if (!parsed.ok) throw new TypeError(`invalid fixed XPC Mach service: ${name}`)
	return parsed.value
}

function canonicalFixedPath(input: string): CanonicalPath {
	const parsed = parseCanonicalPath(input)
	if (!parsed.ok) throw new TypeError(`failed to canonicalize fixed path: ${input}`)
	return parsed.value
}

function denyReadRules(patterns: readonly ProtectedPathPattern[]): Rule[] {
	return patterns.map((pattern) =>
		fileRule({ effect: "deny", operations: ["file-read*"], matchers: [matcherForPattern(pattern)] }),
	)
}

function allowReadRules(patterns: readonly ProtectedPathPattern[]): Rule[] {
	return patterns.map((pattern) =>
		fileRule({ effect: "allow", operations: ["file-read*"], matchers: [matcherForPattern(pattern)] }),
	)
}

function denyWriteRules(patterns: readonly ProtectedPathPattern[]): Rule[] {
	return patterns.map((pattern) =>
		fileRule({ effect: "deny", operations: ["file-write*"], matchers: [matcherForPattern(pattern)] }),
	)
}

function denyWriteRulesExceptProcess(
	patterns: readonly ProtectedPathPattern[],
	process: BashIntegrations["gitExecutable"],
): Rule[] {
	return patterns.map((pattern) =>
		fileRuleExceptProcess({
			effect: "deny",
			operations: ["file-write*"],
			matchers: [matcherForPattern(pattern)],
			process,
		}),
	)
}

function matcherForPattern(pattern: ProtectedPathPattern): PathMatcher {
	return pattern.kind === "literal" ? subpath(pattern.path) : pathRegex(pattern.regex)
}

import type { CanonicalExecutable, SeatbeltPath } from "./canonical-path"
import type { CompiledPathRegex } from "./path-pattern"
import { type Result, err, ok } from "./result"

export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]]

export type FileOperation =
	| "file-ioctl"
	| "file-map-executable"
	| "file-read*"
	| "file-read-data"
	| "file-read-metadata"
	| "file-write*"
	| "file-write-create"
	| "file-write-data"
	| "file-write-unlink"

export type RuleEffect = "allow" | "deny"
export type FileExtensionClass = "com.apple.app-sandbox.read" | "com.apple.app-sandbox.read-write"
export type WebKitBrokerExtension = "generic" | "iokit" | "mach"
export type RuntimeOperation =
	| "appleevent-send"
	| "lsopen"
	| "process-exec"
	| "process-fork"
	| "pseudo-tty"
	| "sysctl-read"
	| "system-socket"
export type SameSandboxOperation = "mach-priv-task-port" | "process-info*" | "signal"
export type IpNetworkOperation = "network-bind" | "network-inbound" | "network-outbound"

export type MachServiceNameError = {
	readonly kind: "invalid-mach-service-name"
	readonly input: string
}

export type PosixIpcNameError = {
	readonly kind: "invalid-posix-ipc-name"
	readonly input: string
}

declare const globalServiceNameBrand: unique symbol
declare const xpcServiceNameBrand: unique symbol
declare const pathMatcherBrand: unique symbol
declare const unixSocketMatcherBrand: unique symbol
declare const ruleBrand: unique symbol
declare const posixIpcNameBrand: unique symbol

type GlobalServiceName = string & { readonly [globalServiceNameBrand]: true }
type XpcServiceName = string & { readonly [xpcServiceNameBrand]: true }
type PosixIpcName = string & { readonly [posixIpcNameBrand]: true }

type MachService =
	| { readonly kind: "global-name"; readonly name: GlobalServiceName }
	| { readonly kind: "xpc-service-name"; readonly name: XpcServiceName }

type PathMatcherNode =
	| { readonly kind: "literal"; readonly path: SeatbeltPath }
	| { readonly kind: "subpath"; readonly path: SeatbeltPath }
	| { readonly kind: "prefix"; readonly path: SeatbeltPath }
	| { readonly kind: "regex"; readonly pattern: CompiledPathRegex }

export type PathMatcher = PathMatcherNode & { readonly [pathMatcherBrand]: true }

type UnixSocketMatcherNode =
	| { readonly kind: "path"; readonly path: SeatbeltPath }
	| { readonly kind: "subpath"; readonly path: SeatbeltPath }

export type UnixSocketMatcher = UnixSocketMatcherNode & { readonly [unixSocketMatcherBrand]: true }

type ProcessScope = { readonly process?: CanonicalExecutable }

type FileRule = ProcessScope & {
	readonly kind: "file"
	readonly effect: RuleEffect
	readonly operations: NonEmptyReadonlyArray<FileOperation>
	readonly matchers: NonEmptyReadonlyArray<PathMatcher>
}

type FileRuleExceptProcess = {
	readonly kind: "file-except-process"
	readonly effect: RuleEffect
	readonly operations: NonEmptyReadonlyArray<FileOperation>
	readonly matchers: NonEmptyReadonlyArray<PathMatcher>
	readonly process: CanonicalExecutable
}

type FileRuleExceptProcesses = {
	readonly kind: "file-except-processes"
	readonly effect: RuleEffect
	readonly operations: NonEmptyReadonlyArray<FileOperation>
	readonly matchers: NonEmptyReadonlyArray<PathMatcher>
	readonly processes: NonEmptyReadonlyArray<CanonicalExecutable>
}

type MachLookupRule = ProcessScope & {
	readonly kind: "mach-lookup"
	readonly effect: RuleEffect
	readonly services: NonEmptyReadonlyArray<MachService>
}

type UnixSocketRule = ProcessScope & {
	readonly kind: "unix-bind" | "unix-connect"
	readonly effect: RuleEffect
	readonly matchers: NonEmptyReadonlyArray<UnixSocketMatcher>
}

type FileExtensionGrant = {
	readonly extensionClass: FileExtensionClass
	readonly matchers: NonEmptyReadonlyArray<PathMatcher>
}

type FileExtensionIssueRule = {
	readonly kind: "file-extension-issue"
	readonly effect: RuleEffect
	readonly grants: NonEmptyReadonlyArray<FileExtensionGrant>
	readonly process: CanonicalExecutable
}

type BrokerExtensionIssueRule = {
	readonly kind: "broker-extension-issue"
	readonly extension: WebKitBrokerExtension
	readonly process: CanonicalExecutable
}

type RuntimeOperationRule = {
	readonly kind: "runtime-operation"
	readonly effect: RuleEffect
	readonly operations: NonEmptyReadonlyArray<RuntimeOperation>
}

type SameSandboxRule = {
	readonly kind: "same-sandbox"
	readonly effect: RuleEffect
	readonly operations: NonEmptyReadonlyArray<SameSandboxOperation>
}

type IpNetworkRule = {
	readonly kind: "ip-network"
	readonly effect: RuleEffect
	readonly operation: IpNetworkOperation
	readonly endpoint: "local" | "remote"
}

type NetworkPathRule = {
	readonly kind: "network-path"
	readonly effect: RuleEffect
	readonly operation: "network-outbound"
	readonly path: SeatbeltPath
}

type PosixIpcRule = {
	readonly kind: "posix-ipc"
	readonly effect: RuleEffect
	readonly operation: "ipc-posix-shm-read-data"
	readonly name: PosixIpcName
}

type RuleNode =
	| FileRule
	| FileRuleExceptProcess
	| FileRuleExceptProcesses
	| MachLookupRule
	| UnixSocketRule
	| FileExtensionIssueRule
	| BrokerExtensionIssueRule
	| RuntimeOperationRule
	| SameSandboxRule
	| IpNetworkRule
	| NetworkPathRule
	| PosixIpcRule
export type Rule = RuleNode & { readonly [ruleBrand]: true }

export type CompiledSbpl = {
	readonly source: string
	readonly parameters: readonly SbplParameter[]
}

export type SbplParameter = {
	readonly name: string
	readonly value: string
}

export function literal(path: SeatbeltPath): PathMatcher {
	return Object.freeze({ kind: "literal", path }) as PathMatcher
}

export function subpath(path: SeatbeltPath): PathMatcher {
	return Object.freeze({ kind: "subpath", path }) as PathMatcher
}

export function pathPrefix(path: SeatbeltPath): PathMatcher {
	return Object.freeze({ kind: "prefix", path }) as PathMatcher
}

export function pathRegex(pattern: CompiledPathRegex): PathMatcher {
	return Object.freeze({ kind: "regex", pattern }) as PathMatcher
}

export function unixSocketPath(path: SeatbeltPath): UnixSocketMatcher {
	return Object.freeze({ kind: "path", path }) as UnixSocketMatcher
}

export function unixSocketSubpath(path: SeatbeltPath): UnixSocketMatcher {
	return Object.freeze({ kind: "subpath", path }) as UnixSocketMatcher
}

export function globalMachService(input: string): Result<MachService, MachServiceNameError> {
	if (!isMachServiceName(input)) return invalidMachServiceName(input)
	const name = input as GlobalServiceName
	return ok(Object.freeze({ kind: "global-name", name }))
}

export function xpcMachService(input: string): Result<MachService, MachServiceNameError> {
	if (!isMachServiceName(input)) return invalidMachServiceName(input)
	const name = input as XpcServiceName
	return ok(Object.freeze({ kind: "xpc-service-name", name }))
}

export function allowRuntimeOperations(operations: NonEmptyReadonlyArray<RuntimeOperation>): Rule {
	assertNonEmpty(operations, "runtime operations")
	return freezeRule({ kind: "runtime-operation", effect: "allow", operations: freezeTuple(operations) })
}

export function allowSameSandbox(operations: NonEmptyReadonlyArray<SameSandboxOperation>): Rule {
	assertNonEmpty(operations, "same-sandbox operations")
	return freezeRule({ kind: "same-sandbox", effect: "allow", operations: freezeTuple(operations) })
}

export function allowIpNetwork(input: {
	readonly operation: IpNetworkOperation
	readonly endpoint: "local" | "remote"
}): Rule {
	return freezeRule({ kind: "ip-network", effect: "allow", ...input })
}

export function allowNetworkPath(path: SeatbeltPath): Rule {
	return freezeRule({ kind: "network-path", effect: "allow", operation: "network-outbound", path })
}

export function allowPosixSharedMemoryRead(input: string): Result<Rule, PosixIpcNameError> {
	if (!isMachServiceName(input)) return err({ kind: "invalid-posix-ipc-name", input })
	return ok(
		freezeRule({
			kind: "posix-ipc",
			effect: "allow",
			operation: "ipc-posix-shm-read-data",
			name: input as PosixIpcName,
		}),
	)
}

export function fileRule(input: {
	readonly effect: RuleEffect
	readonly operations: NonEmptyReadonlyArray<FileOperation>
	readonly matchers: NonEmptyReadonlyArray<PathMatcher>
	readonly process?: CanonicalExecutable
}): Rule {
	assertNonEmpty(input.operations, "file operations")
	assertNonEmpty(input.matchers, "file matchers")
	return freezeRule({
		kind: "file",
		effect: input.effect,
		operations: freezeTuple(input.operations),
		matchers: freezeTuple(input.matchers),
		...(input.process === undefined ? {} : { process: input.process }),
	})
}

export function fileRuleExceptProcess(input: {
	readonly effect: RuleEffect
	readonly operations: NonEmptyReadonlyArray<FileOperation>
	readonly matchers: NonEmptyReadonlyArray<PathMatcher>
	readonly process: CanonicalExecutable
}): Rule {
	return fileRuleExceptProcesses({ ...input, processes: [input.process] })
}

export function fileRuleExceptProcesses(input: {
	readonly effect: RuleEffect
	readonly operations: NonEmptyReadonlyArray<FileOperation>
	readonly matchers: NonEmptyReadonlyArray<PathMatcher>
	readonly processes: NonEmptyReadonlyArray<CanonicalExecutable>
}): Rule {
	assertNonEmpty(input.operations, "file operations")
	assertNonEmpty(input.matchers, "file matchers")
	assertNonEmpty(input.processes, "excluded processes")
	if (input.processes.length === 1) {
		return freezeRule({
			kind: "file-except-process",
			effect: input.effect,
			operations: freezeTuple(input.operations),
			matchers: freezeTuple(input.matchers),
			process: input.processes[0],
		})
	}
	return freezeRule({
		kind: "file-except-processes",
		effect: input.effect,
		operations: freezeTuple(input.operations),
		matchers: freezeTuple(input.matchers),
		processes: freezeTuple(input.processes),
	})
}

export function machLookupRule(input: {
	readonly effect: RuleEffect
	readonly services: NonEmptyReadonlyArray<MachService>
	readonly process?: CanonicalExecutable
}): Rule {
	assertNonEmpty(input.services, "Mach services")
	return freezeRule({
		kind: "mach-lookup",
		effect: input.effect,
		services: freezeTuple(input.services),
		...(input.process === undefined ? {} : { process: input.process }),
	})
}

export function unixConnectRule(input: {
	readonly effect: RuleEffect
	readonly matchers: NonEmptyReadonlyArray<UnixSocketMatcher>
	readonly process?: CanonicalExecutable
}): Rule {
	return unixSocketRule("unix-connect", input)
}

export function unixBindRule(input: {
	readonly effect: RuleEffect
	readonly matchers: NonEmptyReadonlyArray<UnixSocketMatcher>
	readonly process?: CanonicalExecutable
}): Rule {
	return unixSocketRule("unix-bind", input)
}

export function allowFileExtensionIssue(input: {
	readonly extensionClass: FileExtensionClass
	readonly matchers: NonEmptyReadonlyArray<PathMatcher>
	readonly process: CanonicalExecutable
}): Rule {
	return fileExtensionIssueRule("allow", input)
}

export function allowFileExtensionIssues(input: {
	readonly grants: NonEmptyReadonlyArray<FileExtensionGrant>
	readonly process: CanonicalExecutable
}): Rule {
	assertNonEmpty(input.grants, "file extension grants")
	const freezeGrant = (grant: FileExtensionGrant): FileExtensionGrant =>
		Object.freeze({
			extensionClass: grant.extensionClass,
			matchers: freezeTuple(grant.matchers),
		})
	const [first, ...rest] = input.grants
	return freezeRule({
		kind: "file-extension-issue",
		effect: "allow",
		grants: freezeTuple([freezeGrant(first), ...rest.map(freezeGrant)]),
		process: input.process,
	})
}

export function denyFileExtensionIssue(input: {
	readonly extensionClass: FileExtensionClass
	readonly matchers: NonEmptyReadonlyArray<PathMatcher>
	readonly process: CanonicalExecutable
}): Rule {
	return fileExtensionIssueRule("deny", input)
}

function fileExtensionIssueRule(
	effect: RuleEffect,
	input: {
		readonly extensionClass: FileExtensionClass
		readonly matchers: NonEmptyReadonlyArray<PathMatcher>
		readonly process: CanonicalExecutable
	},
): Rule {
	assertNonEmpty(input.matchers, "file extension matchers")
	return freezeRule({
		kind: "file-extension-issue",
		effect,
		grants: freezeTuple([
			Object.freeze({ extensionClass: input.extensionClass, matchers: freezeTuple(input.matchers) }),
		]),
		process: input.process,
	})
}

export function allowWebKitBrokerExtension(extension: WebKitBrokerExtension, process: CanonicalExecutable): Rule {
	return freezeRule({ kind: "broker-extension-issue", extension, process })
}

export function emitSbpl(rules: readonly Rule[]): CompiledSbpl {
	const parameters = new ParameterEmitter()
	const source = rules.map((rule) => emitRule(rule, parameters)).join("\n")
	return Object.freeze({ source, parameters: Object.freeze(parameters.definitions()) })
}

export function emitSbplProfile(rules: readonly Rule[]): CompiledSbpl {
	const compiled = emitSbpl(rules)
	return Object.freeze({
		source: `(version 1)\n(deny default)\n${compiled.source}\n`,
		parameters: compiled.parameters,
	})
}

function unixSocketRule(
	kind: UnixSocketRule["kind"],
	input: {
		readonly effect: RuleEffect
		readonly matchers: NonEmptyReadonlyArray<UnixSocketMatcher>
		readonly process?: CanonicalExecutable
	},
): Rule {
	assertNonEmpty(input.matchers, "Unix socket matchers")
	return freezeRule({
		kind,
		effect: input.effect,
		matchers: freezeTuple(input.matchers),
		...(input.process === undefined ? {} : { process: input.process }),
	})
}

function emitRule(rule: RuleNode, parameters: ParameterEmitter): string {
	if (rule.kind === "file-except-processes") {
		const processFilters = rule.processes.map((process) => `(process-path ${parameters.reference(process)})`)
		const excluded = `(require-not (require-any ${processFilters.join(" ")}))`
		return [`(with-filter ${excluded}`, indent(emitFileRule({ ...rule, kind: "file" }, parameters)), ")"].join("\n")
	}
	if (!("process" in rule) || rule.process === undefined) return emitUnscopedRule(rule, parameters)
	const process = parameters.reference(rule.process)
	const unscoped =
		rule.kind === "file-except-process"
			? emitFileRule({ ...rule, kind: "file" }, parameters)
			: emitUnscopedRule(rule, parameters)
	const filter =
		rule.kind === "file-except-process" ? `(require-not (process-path ${process}))` : `(process-path ${process})`
	return [`(with-filter ${filter}`, indent(unscoped), ")"].join("\n")
}

function emitUnscopedRule(rule: RuleNode, parameters: ParameterEmitter): string {
	switch (rule.kind) {
		case "file":
			return emitFileRule(rule, parameters)
		case "file-except-process":
		case "file-except-processes":
			throw new TypeError("except-process rules must be emitted through their process filter")
		case "mach-lookup":
			return emitMachLookupRule(rule, parameters)
		case "unix-bind":
			return emitUnixSocketRule(rule, "network-bind", "local", parameters)
		case "unix-connect":
			return emitUnixSocketRule(rule, "network-outbound", "remote", parameters)
		case "file-extension-issue":
			return emitFileExtensionIssueRule(rule, parameters)
		case "broker-extension-issue":
			return emitBrokerExtensionIssueRule(rule)
		case "runtime-operation":
			return `(${rule.effect} ${rule.operations.join(" ")})`
		case "same-sandbox":
			return `(${rule.effect} ${rule.operations.join(" ")} (target same-sandbox))`
		case "ip-network":
			return `(${rule.effect} ${rule.operation} (${rule.endpoint} ip))`
		case "network-path":
			return `(${rule.effect} ${rule.operation} (literal ${parameters.reference(rule.path)}))`
		case "posix-ipc":
			return `(${rule.effect} ${rule.operation} (ipc-posix-name ${parameters.reference(rule.name)}))`
		default:
			return rule satisfies never
	}
}

function emitFileRule(rule: FileRule, parameters: ParameterEmitter): string {
	const head = `(${rule.effect} ${rule.operations.join(" ")}`
	const filters = rule.matchers.map((matcher) => emitPathMatcher(matcher, parameters))
	return [head, ...filters.map(indent), ")"].join("\n")
}

function emitMachLookupRule(rule: MachLookupRule, parameters: ParameterEmitter): string {
	const globalNames: string[] = []
	const xpcNames: string[] = []
	for (const service of rule.services) {
		switch (service.kind) {
			case "global-name":
				globalNames.push(parameters.reference(service.name))
				break
			case "xpc-service-name":
				xpcNames.push(parameters.reference(service.name))
				break
			default:
				service satisfies never
		}
	}

	const filters: string[] = []
	if (globalNames.length > 0) filters.push(`(global-name ${globalNames.join(" ")})`)
	if (xpcNames.length > 0) filters.push(`(xpc-service-name ${xpcNames.join(" ")})`)
	return [`(${rule.effect} mach-lookup`, ...filters.map(indent), ")"].join("\n")
}

function emitUnixSocketRule(
	rule: UnixSocketRule,
	operation: "network-bind" | "network-outbound",
	endpoint: "local" | "remote",
	parameters: ParameterEmitter,
): string {
	const filters = rule.matchers.map(
		(matcher) => `(${endpoint} unix-socket ${emitUnixSocketMatcher(matcher, parameters)})`,
	)
	return [`(${rule.effect} ${operation}`, ...filters.map(indent), ")"].join("\n")
}

function emitFileExtensionIssueRule(rule: FileExtensionIssueRule, parameters: ParameterEmitter): string {
	const grants = rule.grants.flatMap((grant) => {
		const matchers = grant.matchers.map((matcher) => emitPathMatcher(matcher, parameters))
		return [
			"  (require-all",
			`    (extension-class \"${grant.extensionClass}\")`,
			"    (require-any",
			...matchers.map((matcher) => `      ${matcher}`),
			"    )",
			"  )",
		]
	})
	return [`(${rule.effect} file-issue-extension`, ...grants, ")"].join("\n")
}

function emitBrokerExtensionIssueRule(rule: BrokerExtensionIssueRule): string {
	const [operation, extensionClass] = webKitBrokerExtension(rule.extension)
	return `(allow ${operation} (extension-class \"${extensionClass}\"))`
}

function emitPathMatcher(matcher: PathMatcherNode, parameters: ParameterEmitter): string {
	switch (matcher.kind) {
		case "literal":
		case "subpath":
			return `(${matcher.kind} ${parameters.reference(matcher.path)})`
		case "prefix":
			return `(regex ${parameters.reference(`^${escapeSeatbeltRegex(matcher.path)}`)})`
		case "regex":
			return `(regex ${parameters.reference(matcher.pattern)})`
		default:
			return matcher satisfies never
	}
}

function emitUnixSocketMatcher(matcher: UnixSocketMatcherNode, parameters: ParameterEmitter): string {
	return `(${matcher.kind} ${parameters.reference(matcher.path)})`
}

function webKitBrokerExtension(extension: WebKitBrokerExtension): readonly [string, string] {
	switch (extension) {
		case "generic":
			return ["generic-issue-extension", "com.apple.webkit.mach-bootstrap"]
		case "iokit":
			return ["iokit-issue-extension", "com.apple.webkit.extension.iokit"]
		case "mach":
			return ["mach-issue-extension", "com.apple.webkit.extension.mach"]
		default:
			return extension satisfies never
	}
}

class ParameterEmitter {
	readonly #namesByValue = new Map<string, string>()
	readonly #parameters: SbplParameter[] = []

	reference(value: string): string {
		const existing = this.#namesByValue.get(value)
		if (existing !== undefined) return `(param \"${existing}\")`

		const name = `PI_SAFETY_${this.#parameters.length}`
		this.#namesByValue.set(value, name)
		this.#parameters.push(Object.freeze({ name, value }))
		return `(param \"${name}\")`
	}

	definitions(): readonly SbplParameter[] {
		return [...this.#parameters]
	}
}

function freezeRule(rule: RuleNode): Rule {
	return Object.freeze(rule) as Rule
}

function freezeTuple<T>(items: NonEmptyReadonlyArray<T>): NonEmptyReadonlyArray<T> {
	return Object.freeze([...items]) as unknown as NonEmptyReadonlyArray<T>
}

function assertNonEmpty<T>(items: readonly T[], label: string): asserts items is NonEmptyReadonlyArray<T> {
	if (items.length === 0) throw new TypeError(`${label} must not be empty`)
}

function isMachServiceName(input: string): boolean {
	return /^[A-Za-z0-9._:@-]+$/.test(input)
}

function invalidMachServiceName(input: string): Result<never, MachServiceNameError> {
	return err({ kind: "invalid-mach-service-name", input })
}

function escapeSeatbeltRegex(input: string): string {
	return input.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
}

function indent(input: string): string {
	return input
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n")
}

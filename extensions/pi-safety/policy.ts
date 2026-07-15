import type { CanonicalExecutable, CanonicalPath, SeatbeltPath } from "./canonical-path"
import { isCanonicalPathWithin } from "./canonical-path"
import type { PathPattern } from "./path-pattern"
import { matchesPathPattern } from "./path-pattern"
import { type NonEmptyReadonlyArray, type Rule, type RuntimeOperation, allowRuntimeOperations } from "./sbpl"

export {
	type PathMatcher,
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
	unixSocketPath,
	unixSocketSubpath,
	xpcMachService,
} from "./sbpl"

declare const fileSelectorBrand: unique symbol
declare const policyRuleBrand: unique symbol
declare const policyBrand: unique symbol
declare const ruleSubjectBrand: unique symbol

export type FileAccess = "none" | "read-only" | "read-write"
export type SnapshotDisposition = "include" | "exclude"
export type FileOperation = "read" | "write" | "movement"

export type SharedRuleSubject = { readonly kind: "shared" } & { readonly [ruleSubjectBrand]: true }
export type SandboxRuleSubject = { readonly kind: "sandbox" } & { readonly [ruleSubjectBrand]: true }
export type ExecutableRuleSubject = {
	readonly kind: "executable"
	readonly executable: CanonicalExecutable
} & { readonly [ruleSubjectBrand]: true }
export type RuleSubject = SharedRuleSubject | SandboxRuleSubject | ExecutableRuleSubject

export type EvaluationSubject =
	| { readonly kind: "builtin" }
	| { readonly kind: "snapshot" }
	| { readonly kind: "sandbox" }
	| { readonly kind: "executable"; readonly executable: CanonicalExecutable }

export type FileSelector =
	| ({ readonly kind: "file"; readonly path: CanonicalPath } & { readonly [fileSelectorBrand]: true })
	| ({ readonly kind: "tree"; readonly path: CanonicalPath } & { readonly [fileSelectorBrand]: true })
	| ({ readonly kind: "seatbelt-file"; readonly path: SeatbeltPath } & { readonly [fileSelectorBrand]: true })
	| ({ readonly kind: "seatbelt-tree"; readonly path: SeatbeltPath } & { readonly [fileSelectorBrand]: true })
	| ({ readonly kind: "seatbelt-prefix"; readonly path: SeatbeltPath } & { readonly [fileSelectorBrand]: true })
	| ({
			readonly kind: "glob"
			readonly pattern: Extract<PathPattern, { readonly kind: "glob" }>
	  } & { readonly [fileSelectorBrand]: true })

export type FileAccessRule = {
	readonly kind: "file-access"
	readonly subject: RuleSubject
	readonly selector: FileSelector
	readonly access: FileAccess
	readonly [policyRuleBrand]: true
}

export type SnapshotRule = {
	readonly kind: "snapshot"
	readonly selector: FileSelector
	readonly disposition: SnapshotDisposition
	readonly [policyRuleBrand]: true
}

export type RuntimePolicyRule = Rule
export type PolicyRule = FileAccessRule | SnapshotRule | RuntimePolicyRule

export interface Policy {
	readonly workspaceRoot: CanonicalPath
	readonly homeRoot: CanonicalPath
	readonly rules: readonly PolicyRule[]
	readonly [policyBrand]: true
}

export type FileAccessRequest = {
	readonly kind: "file-access"
	readonly operation: FileOperation
	readonly subject: EvaluationSubject
	readonly path: CanonicalPath
}

export type FileAccessDecision = {
	readonly effect: "allow" | "deny"
	readonly access: FileAccess
}

export type SnapshotRequest = {
	readonly kind: "snapshot"
	readonly path: CanonicalPath
}

export type SnapshotDecision = {
	readonly disposition: SnapshotDisposition
}

const sharedSubject = Object.freeze({ kind: "shared" }) as SharedRuleSubject
const sandboxSubject = Object.freeze({ kind: "sandbox" }) as SandboxRuleSubject

export function shared(): SharedRuleSubject {
	return sharedSubject
}

export function sandbox(): SandboxRuleSubject {
	return sandboxSubject
}

export function executable(executable: CanonicalExecutable): ExecutableRuleSubject {
	return Object.freeze({ kind: "executable", executable }) as ExecutableRuleSubject
}

export function file(path: CanonicalPath): FileSelector {
	return Object.freeze({ kind: "file", path }) as FileSelector
}

export function tree(path: CanonicalPath): FileSelector {
	return Object.freeze({ kind: "tree", path }) as FileSelector
}

export function seatbeltFile(path: SeatbeltPath): FileSelector {
	return Object.freeze({ kind: "seatbelt-file", path }) as FileSelector
}

export function seatbeltTree(path: SeatbeltPath): FileSelector {
	return Object.freeze({ kind: "seatbelt-tree", path }) as FileSelector
}

export function seatbeltPrefix(path: SeatbeltPath): FileSelector {
	return Object.freeze({ kind: "seatbelt-prefix", path }) as FileSelector
}

export function pattern(pattern: PathPattern): FileSelector {
	return pattern.kind === "literal" ? tree(pattern.path) : (Object.freeze({ kind: "glob", pattern }) as FileSelector)
}

export function noAccess(subject: RuleSubject, selector: FileSelector): FileAccessRule {
	return accessRule("none", subject, selector)
}

export function readOnly(subject: RuleSubject, selector: FileSelector): FileAccessRule {
	return accessRule("read-only", subject, selector)
}

export function readWrite(subject: RuleSubject, selector: FileSelector): FileAccessRule {
	return accessRule("read-write", subject, selector)
}

export function allowRuntime(operations: NonEmptyReadonlyArray<RuntimeOperation>): Rule {
	return allowRuntimeOperations(operations)
}

export function includeInSnapshots(selector: FileSelector): SnapshotRule {
	return snapshotRule("include", selector)
}

export function excludeFromSnapshots(selector: FileSelector): SnapshotRule {
	return snapshotRule("exclude", selector)
}

export function definePolicy(input: {
	readonly workspaceRoot: CanonicalPath
	readonly homeRoot: CanonicalPath
	readonly rules: readonly PolicyRule[]
}): Policy {
	let runtimeRulesStarted = false
	for (const rule of input.rules) {
		if (rule.kind === "file-access" || rule.kind === "snapshot") {
			if (runtimeRulesStarted) throw new TypeError("declarative policy rules must precede runtime rules")
		} else {
			runtimeRulesStarted = true
		}
	}
	return Object.freeze({
		workspaceRoot: input.workspaceRoot,
		homeRoot: input.homeRoot,
		rules: Object.freeze([...input.rules]),
	}) as Policy
}

export function evaluatePolicy(policy: Policy, request: FileAccessRequest): FileAccessDecision
export function evaluatePolicy(policy: Policy, request: SnapshotRequest): SnapshotDecision
export function evaluatePolicy(
	policy: Policy,
	request: FileAccessRequest | SnapshotRequest,
): FileAccessDecision | SnapshotDecision {
	switch (request.kind) {
		case "file-access":
			return evaluateFileAccess(policy, request)
		case "snapshot":
			return evaluateSnapshot(policy, request)
		default:
			return request satisfies never
	}
}

function evaluateFileAccess(policy: Policy, request: FileAccessRequest): FileAccessDecision {
	let access: FileAccess = "none"
	for (const rule of effectiveFileAccessRules(policy, request.subject)) {
		const matches =
			request.operation === "movement"
				? matchesMovementSelector(rule.selector, request.path, rule.access)
				: matchesSelector(rule.selector, request.path)
		if (!matches) continue
		access = rule.access
	}
	const allowed = request.operation === "read" ? access !== "none" : access === "read-write"
	return Object.freeze({ effect: allowed ? "allow" : "deny", access })
}

function evaluateSnapshot(policy: Policy, request: SnapshotRequest): SnapshotDecision {
	let disposition: SnapshotDisposition = "include"
	for (const rule of policy.rules) {
		switch (rule.kind) {
			case "snapshot":
				if (!matchesSelector(rule.selector, request.path)) break
				disposition = rule.disposition
				break
			case "file-access":
			case "file":
			case "file-except-processes":
			case "mach-lookup":
			case "unix-bind":
			case "unix-connect":
			case "file-extension-issue":
			case "broker-extension-issue":
			case "runtime-operation":
			case "same-sandbox":
			case "ip-network":
			case "network-path":
			case "posix-ipc":
				break
			default:
				rule satisfies never
		}
	}
	return Object.freeze({ disposition })
}

export function effectiveFileAccessRules(policy: Policy, subject: EvaluationSubject): readonly FileAccessRule[] {
	const seen = new Set<string>()
	const retained: FileAccessRule[] = []
	for (let index = policy.rules.length - 1; index >= 0; index -= 1) {
		const rule = policy.rules[index]
		if (rule === undefined || rule.kind !== "file-access" || !matchesSubject(rule.subject, subject)) continue
		const key = selectorKey(rule.selector)
		if (seen.has(key)) continue
		seen.add(key)
		retained.push(rule)
	}
	return Object.freeze(retained.reverse())
}

export function matchesSelector(selector: FileSelector, candidate: CanonicalPath): boolean {
	switch (selector.kind) {
		case "file":
			return selector.path === candidate
		case "tree":
			return isCanonicalPathWithin(selector.path, candidate)
		case "seatbelt-prefix":
			return candidate.startsWith(selector.path)
		case "seatbelt-file":
			return candidate === selector.path
		case "seatbelt-tree":
			return isPathWithin(selector.path, candidate)
		case "glob":
			return matchesPathPattern(selector.pattern, candidate)
		default:
			return selector satisfies never
	}
}

function matchesMovementSelector(selector: FileSelector, candidate: CanonicalPath, access: FileAccess): boolean {
	if (matchesSelector(selector, candidate)) return true
	if (access === "read-write") return false
	switch (selector.kind) {
		case "file":
		case "tree":
			return isCanonicalPathWithin(candidate, selector.path)
		case "seatbelt-file":
		case "seatbelt-tree":
		case "seatbelt-prefix":
			return isPathWithin(candidate, selector.path)
		case "glob":
			return isCanonicalPathWithin(candidate, selector.pattern.staticBase)
		default:
			return selector satisfies never
	}
}

function selectorKey(selector: FileSelector): string {
	switch (selector.kind) {
		case "file":
			return `file:${selector.path}`
		case "tree":
			return `tree:${selector.path}`
		case "seatbelt-file":
			return `seatbelt-file:${selector.path}`
		case "seatbelt-tree":
			return `seatbelt-tree:${selector.path}`
		case "seatbelt-prefix":
			return `seatbelt-prefix:${selector.path}`
		case "glob":
			return `glob:${selector.pattern.pattern}`
		default:
			return selector satisfies never
	}
}

function isPathWithin(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(root.endsWith("/") ? root : `${root}/`)
}

function matchesSubject(rule: RuleSubject, request: EvaluationSubject): boolean {
	switch (rule.kind) {
		case "shared":
			return true
		case "sandbox":
			return request.kind === "sandbox" || request.kind === "executable"
		case "executable":
			return request.kind === "executable" && request.executable === rule.executable
		default:
			return rule satisfies never
	}
}

function accessRule(access: FileAccess, subject: RuleSubject, selector: FileSelector): FileAccessRule {
	return Object.freeze({ kind: "file-access", subject, selector, access }) as FileAccessRule
}

function snapshotRule(disposition: SnapshotDisposition, selector: FileSelector): SnapshotRule {
	return Object.freeze({ kind: "snapshot", selector, disposition }) as SnapshotRule
}

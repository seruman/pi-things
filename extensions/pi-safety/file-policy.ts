import type { CanonicalExecutable, CanonicalPath } from "./canonical-path"
import { isCanonicalPathWithin } from "./canonical-path"
import type { PathPattern } from "./path-pattern"
import { matchesPathPattern } from "./path-pattern"

declare const fileSelectorBrand: unique symbol
declare const filePolicyRuleBrand: unique symbol
declare const filePolicyBrand: unique symbol

export type FileAccess = "none" | "read-only" | "read-write"
export type SnapshotDisposition = "include" | "exclude"

export type FileSelector =
	| ({ readonly kind: "file"; readonly path: CanonicalPath } & { readonly [fileSelectorBrand]: true })
	| ({ readonly kind: "tree"; readonly path: CanonicalPath } & { readonly [fileSelectorBrand]: true })
	| ({
			readonly kind: "glob"
			readonly pattern: Extract<PathPattern, { readonly kind: "glob" }>
	  } & { readonly [fileSelectorBrand]: true })

export type FilePolicyRule =
	| ({
			readonly kind: "access"
			readonly selector: FileSelector
			readonly access: FileAccess
			readonly executable?: CanonicalExecutable
			readonly label?: string
	  } & { readonly [filePolicyRuleBrand]: true })
	| ({
			readonly kind: "snapshot"
			readonly selector: FileSelector
			readonly disposition: SnapshotDisposition
			readonly label?: string
	  } & { readonly [filePolicyRuleBrand]: true })

export interface FilePolicyDecision<T> {
	readonly value: T
	readonly rule: FilePolicyRule | undefined
}

export interface FilePolicy {
	readonly workspaceRoot: CanonicalPath
	readonly homeRoot: CanonicalPath
	readonly rules: readonly FilePolicyRule[]
	readonly [filePolicyBrand]: true
}

export function file(path: CanonicalPath): FileSelector {
	return Object.freeze({ kind: "file", path }) as FileSelector
}

export function tree(path: CanonicalPath): FileSelector {
	return Object.freeze({ kind: "tree", path }) as FileSelector
}

export function pattern(pattern: PathPattern): FileSelector {
	return pattern.kind === "literal" ? tree(pattern.path) : (Object.freeze({ kind: "glob", pattern }) as FileSelector)
}

export function noAccess(selector: FileSelector, options: RuleOptions = {}): FilePolicyRule {
	return accessRule("none", selector, options)
}

export function readOnly(selector: FileSelector, options: RuleOptions = {}): FilePolicyRule {
	return accessRule("read-only", selector, options)
}

export function readWrite(selector: FileSelector, options: RuleOptions = {}): FilePolicyRule {
	return accessRule("read-write", selector, options)
}

export function readWriteForExecutable(
	executable: CanonicalExecutable,
	selector: FileSelector,
	options: Omit<RuleOptions, "executable"> = {},
): FilePolicyRule {
	return accessRule("read-write", selector, { ...options, executable })
}

export function includeInSnapshots(selector: FileSelector, options: SnapshotRuleOptions = {}): FilePolicyRule {
	return snapshotRule("include", selector, options)
}

export function excludeFromSnapshots(selector: FileSelector, options: SnapshotRuleOptions = {}): FilePolicyRule {
	return snapshotRule("exclude", selector, options)
}

export function defineFilePolicy(input: {
	readonly workspaceRoot: CanonicalPath
	readonly homeRoot: CanonicalPath
	readonly rules: readonly FilePolicyRule[]
}): FilePolicy {
	return Object.freeze({
		workspaceRoot: input.workspaceRoot,
		homeRoot: input.homeRoot,
		rules: Object.freeze([...input.rules]),
	}) as FilePolicy
}

export function decideFileAccess(
	policy: FilePolicy,
	path: CanonicalPath,
	executable?: CanonicalExecutable,
): FilePolicyDecision<FileAccess> {
	let decision: FilePolicyDecision<FileAccess> = { value: "none", rule: undefined }
	for (const rule of policy.rules) {
		if (rule.kind !== "access" || !matchesSelector(rule.selector, path)) continue
		if (rule.executable !== undefined && rule.executable !== executable) continue
		decision = { value: rule.access, rule }
	}
	return Object.freeze(decision)
}

export function decideSnapshotDisposition(
	policy: FilePolicy,
	path: CanonicalPath,
): FilePolicyDecision<SnapshotDisposition> {
	let decision: FilePolicyDecision<SnapshotDisposition> = { value: "include", rule: undefined }
	for (const rule of policy.rules) {
		if (rule.kind !== "snapshot" || !matchesSelector(rule.selector, path)) continue
		decision = { value: rule.disposition, rule }
	}
	return Object.freeze(decision)
}

export function matchesSelector(selector: FileSelector, candidate: CanonicalPath): boolean {
	switch (selector.kind) {
		case "file":
			return selector.path === candidate
		case "tree":
			return isCanonicalPathWithin(selector.path, candidate)
		case "glob":
			return matchesPathPattern(selector.pattern, candidate)
		default:
			return selector satisfies never
	}
}

type RuleOptions = {
	readonly executable?: CanonicalExecutable
	readonly label?: string
}

type SnapshotRuleOptions = {
	readonly label?: string
}

function accessRule(access: FileAccess, selector: FileSelector, options: RuleOptions): FilePolicyRule {
	return Object.freeze({
		kind: "access",
		selector,
		access,
		...(options.executable === undefined ? {} : { executable: options.executable }),
		...(options.label === undefined ? {} : { label: options.label }),
	}) as FilePolicyRule
}

function snapshotRule(
	disposition: SnapshotDisposition,
	selector: FileSelector,
	options: SnapshotRuleOptions,
): FilePolicyRule {
	return Object.freeze({
		kind: "snapshot",
		selector,
		disposition,
		...(options.label === undefined ? {} : { label: options.label }),
	}) as FilePolicyRule
}

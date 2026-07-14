import { type CanonicalExecutable, type CanonicalPath, parseCanonicalPath, seatbeltPathAliases } from "./canonical-path"
import { defaultRuntimeRules } from "./default-rules"
import type { FilePolicy, FilePolicyRule, FileSelector } from "./file-policy"
import type { BashIntegrations } from "./integrations"
import { type MovementProtectionScope, movementRuleForSelector } from "./move-protection"
import {
	type CompiledSbpl,
	type PathMatcher,
	type Rule,
	emitSbplProfile,
	fileRule,
	fileRuleExceptProcess,
	fileRuleExceptProcesses,
	literal,
	pathRegex,
	subpath,
} from "./sbpl"

const ROOT_PATH = canonicalFixedPath("/")

export function compileBashProfile(input: {
	readonly policy: FilePolicy
	readonly integrations: BashIntegrations
}): CompiledSbpl {
	const accessRules = input.policy.rules.filter(
		(rule): rule is Extract<FilePolicyRule, { readonly kind: "access" }> => rule.kind === "access",
	)
	const groups = accessRuleCompilationGroups(accessRules)
	const rules: Rule[] = [
		...defaultRuntimeRules({ policy: input.policy, integrations: input.integrations }),
		...groups.flatMap((group) => group.rules.flatMap((rule) => writeRulesForPolicyRule(rule, group.scope))),
		...groups.flatMap((group) => group.rules.flatMap((rule) => movementRulesForPolicyRule(rule, group.scope))),
		...groups.flatMap((group) => group.rules.map((rule) => readRuleForPolicyRule(rule, group.scope))),
	]
	return emitSbplProfile(rules)
}

function canonicalFixedPath(input: string): CanonicalPath {
	const parsed = parseCanonicalPath(input)
	if (!parsed.ok) throw new TypeError(`failed to canonicalize fixed path: ${input}`)
	return parsed.value
}

type AccessRule = Extract<FilePolicyRule, { readonly kind: "access" }>
type CompilationScope = MovementProtectionScope

type AccessRuleCompilationGroup = {
	readonly rules: readonly AccessRule[]
	readonly scope: CompilationScope
}

function accessRuleCompilationGroups(rules: readonly AccessRule[]): readonly AccessRuleCompilationGroup[] {
	const executables = [
		...new Set(
			rules.flatMap((rule): readonly CanonicalExecutable[] => (rule.executable === undefined ? [] : [rule.executable])),
		),
	]
	const [first, ...rest] = executables
	const genericScope: CompilationScope =
		first === undefined ? { kind: "sandbox" } : { kind: "except-processes", executables: [first, ...rest] }
	return [
		{ rules: keepLastRulePerSelector(rules.filter((rule) => rule.executable === undefined)), scope: genericScope },
		...executables.map(
			(executable): AccessRuleCompilationGroup => ({
				rules: keepLastRulePerSelector(
					rules.filter((rule) => rule.executable === undefined || rule.executable === executable),
				),
				scope: { kind: "process", executable },
			}),
		),
	]
}

function keepLastRulePerSelector(rules: readonly AccessRule[]): readonly AccessRule[] {
	const seen = new Set<string>()
	const retained: AccessRule[] = []
	for (let index = rules.length - 1; index >= 0; index -= 1) {
		const rule = rules[index]
		if (rule === undefined) continue
		const key = selectorKey(rule.selector)
		if (seen.has(key)) continue
		seen.add(key)
		retained.push(rule)
	}
	return retained.reverse()
}

function selectorKey(selector: FileSelector): string {
	switch (selector.kind) {
		case "file":
			return `file:${selector.path}`
		case "tree":
			return `tree:${selector.path}`
		case "glob":
			return `glob:${selector.pattern.pattern}`
		default:
			return selector satisfies never
	}
}

function readRuleForPolicyRule(rule: AccessRule, scope: CompilationScope): Rule {
	return scopedFileRule(
		{
			effect: rule.access === "none" ? "deny" : "allow",
			operations: ["file-read*"],
			matchers: selectorMatchers(rule.selector),
		},
		scope,
	)
}

function writeRulesForPolicyRule(rule: AccessRule, scope: CompilationScope): readonly Rule[] {
	if (isRootReadRule(rule)) return []
	return [
		scopedFileRule(
			{
				effect: rule.access === "read-write" ? "allow" : "deny",
				operations: ["file-write*"],
				matchers: selectorMatchers(rule.selector),
			},
			scope,
		),
	]
}

function movementRulesForPolicyRule(rule: AccessRule, scope: CompilationScope): readonly Rule[] {
	if (isRootReadRule(rule)) return []
	return [movementRuleForSelector({ scope, selector: rule.selector, writable: rule.access === "read-write" })]
}

function scopedFileRule(input: Parameters<typeof fileRule>[0], scope: CompilationScope): Rule {
	switch (scope.kind) {
		case "sandbox":
			return fileRule(input)
		case "process":
			return fileRule({ ...input, process: scope.executable })
		case "except-process":
			return fileRuleExceptProcess({ ...input, process: scope.executable })
		case "except-processes":
			return fileRuleExceptProcesses({ ...input, processes: scope.executables })
		default:
			return scope satisfies never
	}
}

function isRootReadRule(rule: AccessRule): boolean {
	return (
		rule.executable === undefined &&
		rule.access === "read-only" &&
		rule.selector.kind === "tree" &&
		rule.selector.path === ROOT_PATH
	)
}

function selectorMatchers(selector: FileSelector): [PathMatcher, ...PathMatcher[]] {
	switch (selector.kind) {
		case "file":
			return [literal(selector.path), ...seatbeltPathAliases(selector.path).map(literal)]
		case "tree":
			return [
				literal(selector.path),
				subpath(selector.path),
				...seatbeltPathAliases(selector.path).flatMap((alias) => [literal(alias), subpath(alias)]),
			]
		case "glob":
			return [pathRegex(selector.pattern.regex)]
		default:
			return selector satisfies never
	}
}

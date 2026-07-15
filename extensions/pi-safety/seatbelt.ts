import {
	type CanonicalExecutable,
	canonicalAncestors,
	seatbeltPathAliases,
	seatbeltPathAncestors,
} from "./canonical-path"
import { type FileAccessRule, type FileSelector, type Policy, effectiveFileAccessRules } from "./policy"
import {
	type CompiledSbpl,
	type NonEmptyReadonlyArray,
	type PathMatcher,
	type Rule,
	emitSbplProfile,
	fileRule,
	fileRuleExceptProcesses,
	literal,
	pathPrefix,
	pathRegex,
	subpath,
} from "./sbpl"

export function emitSeatbelt(policy: Policy): CompiledSbpl {
	const accessRules = policy.rules.filter((rule): rule is FileAccessRule => rule.kind === "file-access")
	const rules: Rule[] = [
		...accessCompilationGroups(policy, accessRules).flatMap((group) =>
			group.rules.flatMap((rule) => [
				readRule(rule, group.scope),
				writeRule(rule, group.scope),
				movementRule(rule, group.scope),
			]),
		),
		...policy.rules.flatMap(runtimeRule),
	]
	return emitSbplProfile(rules)
}

type CompilationScope =
	| { readonly kind: "sandbox" }
	| { readonly kind: "process"; readonly executable: CanonicalExecutable }
	| {
			readonly kind: "except-processes"
			readonly executables: readonly [CanonicalExecutable, ...CanonicalExecutable[]]
	  }

type AccessCompilationGroup = {
	readonly rules: readonly FileAccessRule[]
	readonly scope: CompilationScope
}

function accessCompilationGroups(policy: Policy, rules: readonly FileAccessRule[]): readonly AccessCompilationGroup[] {
	const executables = [
		...new Set(
			rules.flatMap((rule): readonly CanonicalExecutable[] =>
				rule.subject.kind === "executable" ? [rule.subject.executable] : [],
			),
		),
	]
	const [first, ...rest] = executables
	const genericScope: CompilationScope =
		first === undefined ? { kind: "sandbox" } : { kind: "except-processes", executables: [first, ...rest] }
	return [
		{ rules: effectiveFileAccessRules(policy, { kind: "sandbox" }), scope: genericScope },
		...executables.map(
			(executable): AccessCompilationGroup => ({
				rules: effectiveFileAccessRules(policy, { kind: "executable", executable }),
				scope: { kind: "process", executable },
			}),
		),
	]
}

function runtimeRule(rule: Policy["rules"][number]): readonly Rule[] {
	switch (rule.kind) {
		case "file-access":
		case "snapshot":
			return []
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
			return [rule]
		default:
			return rule satisfies never
	}
}

function readRule(rule: FileAccessRule, scope: CompilationScope): Rule {
	return scopedFileRule(
		{
			effect: rule.access === "none" ? "deny" : "allow",
			operations: ["file-read*"],
			matchers: selectorMatchers(rule.selector),
		},
		scope,
	)
}

function writeRule(rule: FileAccessRule, scope: CompilationScope): Rule {
	return scopedFileRule(
		{
			effect: rule.access === "read-write" ? "allow" : "deny",
			operations: ["file-write*"],
			matchers: selectorMatchers(rule.selector),
		},
		scope,
	)
}

function movementRule(rule: FileAccessRule, scope: CompilationScope): Rule {
	return scopedFileRule(
		{
			effect: rule.access === "read-write" ? "allow" : "deny",
			operations: ["file-write-unlink", "file-write-create"],
			matchers:
				rule.access === "read-write" ? selectorMatchers(rule.selector) : selectorProtectionMatchers(rule.selector),
		},
		scope,
	)
}

function scopedFileRule(input: Parameters<typeof fileRule>[0], scope: CompilationScope): Rule {
	switch (scope.kind) {
		case "sandbox":
			return fileRule(input)
		case "process":
			return fileRule({ ...input, process: scope.executable })
		case "except-processes":
			return fileRuleExceptProcesses({ ...input, processes: scope.executables })
		default:
			return scope satisfies never
	}
}

function selectorMatchers(selector: FileSelector): NonEmptyReadonlyArray<PathMatcher> {
	switch (selector.kind) {
		case "file":
			return [literal(selector.path), ...seatbeltPathAliases(selector.path).map(literal)]
		case "tree":
			return [
				literal(selector.path),
				subpath(selector.path),
				...seatbeltPathAliases(selector.path).flatMap((alias) => [literal(alias), subpath(alias)]),
			]
		case "seatbelt-prefix":
			return [pathPrefix(selector.path)]
		case "seatbelt-file":
			return [literal(selector.path)]
		case "seatbelt-tree":
			return [literal(selector.path), subpath(selector.path)]
		case "glob":
			return [pathRegex(selector.pattern.regex)]
		default:
			return selector satisfies never
	}
}

function selectorProtectionMatchers(selector: FileSelector): NonEmptyReadonlyArray<PathMatcher> {
	switch (selector.kind) {
		case "file":
			return [literal(selector.path), ...canonicalAncestors(selector.path).map(literal)]
		case "tree":
			return [literal(selector.path), subpath(selector.path), ...canonicalAncestors(selector.path).map(literal)]
		case "seatbelt-file":
			return [literal(selector.path), ...seatbeltPathAncestors(selector.path).map(literal)]
		case "seatbelt-tree":
			return [literal(selector.path), subpath(selector.path), ...seatbeltPathAncestors(selector.path).map(literal)]
		case "seatbelt-prefix":
			return [pathPrefix(selector.path), literal(selector.path), ...seatbeltPathAncestors(selector.path).map(literal)]
		case "glob":
			return [
				pathRegex(selector.pattern.regex),
				literal(selector.pattern.staticBase),
				...canonicalAncestors(selector.pattern.staticBase).map(literal),
			]
		default:
			return selector satisfies never
	}
}

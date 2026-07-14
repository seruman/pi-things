import { type CanonicalExecutable, canonicalAncestors } from "./canonical-path"
import type { FileSelector } from "./file-policy"
import {
	type NonEmptyReadonlyArray,
	type PathMatcher,
	type Rule,
	fileRule,
	fileRuleExceptProcess,
	fileRuleExceptProcesses,
	literal,
	pathRegex,
	subpath,
} from "./sbpl"

export type MovementProtectionScope =
	| { readonly kind: "sandbox" }
	| { readonly kind: "process"; readonly executable: CanonicalExecutable }
	| { readonly kind: "except-process"; readonly executable: CanonicalExecutable }
	| {
			readonly kind: "except-processes"
			readonly executables: readonly [CanonicalExecutable, ...CanonicalExecutable[]]
	  }

export function movementRuleForSelector(input: {
	readonly scope: MovementProtectionScope
	readonly selector: FileSelector
	readonly writable: boolean
}): Rule {
	return scopedFileRule(
		{
			effect: input.writable ? "allow" : "deny",
			operations: ["file-write-unlink", "file-write-create"],
			matchers: input.writable ? selectorMatchers(input.selector) : selectorProtectionMatchers(input.selector),
		},
		input.scope,
	)
}

function scopedFileRule(input: Parameters<typeof fileRule>[0], scope: MovementProtectionScope): Rule {
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

function selectorMatchers(selector: FileSelector): NonEmptyReadonlyArray<PathMatcher> {
	switch (selector.kind) {
		case "file":
			return [literal(selector.path)]
		case "tree":
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

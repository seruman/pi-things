import { type CanonicalExecutable, type CanonicalPath, canonicalAncestors } from "./canonical-path"
import type { ProtectedPathPattern } from "./protected-path"
import {
	type NonEmptyReadonlyArray,
	type PathMatcher,
	type Rule,
	fileRule,
	fileRuleExceptProcess,
	literal,
	pathRegex,
	subpath,
} from "./sbpl"

export type MovementProtectionScope =
	| { readonly kind: "sandbox" }
	| { readonly kind: "process"; readonly executable: CanonicalExecutable }
	| { readonly kind: "except-process"; readonly executable: CanonicalExecutable }

export type MovementProtectionInput = {
	readonly scope: MovementProtectionScope
	readonly broadDenied: readonly ProtectedPathPattern[]
	readonly writableRoots: readonly CanonicalPath[]
	readonly terminalDenied: readonly ProtectedPathPattern[]
}

export interface MovementProtectionRulePhases {
	readonly broadDenials: readonly Rule[]
	readonly writableRootAllows: readonly Rule[]
	readonly terminalDenials: readonly Rule[]
}

/** Emit broad movement denials, writable-root re-allows, then terminal denials. */
export function movementProtectionRules(input: MovementProtectionInput): readonly Rule[] {
	const phases = movementProtectionRulePhases(input)
	return Object.freeze([...phases.broadDenials, ...phases.writableRootAllows, ...phases.terminalDenials])
}

/** Keep phases distinct when callers must interleave independent scopes without a later allow weakening an earlier terminal deny. */
export function movementProtectionRulePhases(input: MovementProtectionInput): MovementProtectionRulePhases {
	return Object.freeze({
		broadDenials: Object.freeze(input.broadDenied.map((pattern) => denyMovement(pattern, input.scope))),
		writableRootAllows: Object.freeze(input.writableRoots.map((root) => allowMovement(root, input.scope))),
		terminalDenials: Object.freeze(input.terminalDenied.map((pattern) => denyMovement(pattern, input.scope))),
	})
}

function denyMovement(pattern: ProtectedPathPattern, scope: MovementProtectionScope): Rule {
	return scopedFileRule(
		{
			effect: "deny",
			operations: ["file-write-unlink", "file-write-create"],
			matchers: protectionMatchers(pattern),
		},
		scope,
	)
}

function allowMovement(root: CanonicalPath, scope: MovementProtectionScope): Rule {
	return scopedFileRule(
		{
			effect: "allow",
			operations: ["file-write-unlink", "file-write-create"],
			matchers: [subpath(root)],
		},
		scope,
	)
}

function scopedFileRule(input: Parameters<typeof fileRule>[0], scope: MovementProtectionScope): Rule {
	if (scope.kind === "except-process") {
		return fileRuleExceptProcess({ ...input, process: scope.executable })
	}
	return fileRule({ ...input, ...processScope(scope) })
}

function protectionMatchers(pattern: ProtectedPathPattern): NonEmptyReadonlyArray<PathMatcher> {
	switch (pattern.kind) {
		case "literal":
			return [subpath(pattern.path), ...canonicalAncestors(pattern.path).map(literal)]
		case "glob":
			return [
				pathRegex(pattern.regex),
				literal(pattern.staticBase),
				...canonicalAncestors(pattern.staticBase).map(literal),
			]
		default:
			return pattern satisfies never
	}
}

function processScope(scope: Exclude<MovementProtectionScope, { readonly kind: "except-process" }>): {
	readonly process?: CanonicalExecutable
} {
	switch (scope.kind) {
		case "sandbox":
			return {}
		case "process":
			return { process: scope.executable }
		default:
			return scope satisfies never
	}
}

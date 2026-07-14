import * as path from "node:path"
import globToRegExp from "glob-to-regexp"
import { Minimatch, type MinimatchOptions } from "minimatch"
import {
	type CanonicalPath,
	type CanonicalPathError,
	isCanonicalPathWithin,
	parseCanonicalPath,
} from "./canonical-path"
import { type Result, err, ok } from "./result"

declare const compiledPathRegexBrand: unique symbol
declare const pathPatternBrand: unique symbol

export type CompiledPathRegex = string & { readonly [compiledPathRegexBrand]: true }

type PathPatternNode =
	| { readonly kind: "literal"; readonly path: CanonicalPath }
	| {
			readonly kind: "glob"
			readonly pattern: string
			readonly regex: CompiledPathRegex
			readonly staticBase: CanonicalPath
	  }

export type PathPattern = PathPatternNode & { readonly [pathPatternBrand]: true }

export function literalPathPattern(path: CanonicalPath): PathPattern {
	return Object.freeze({ kind: "literal", path }) as PathPattern
}

export function matchesPathPattern(pattern: PathPattern, candidate: CanonicalPath): boolean {
	if (pattern.kind === "literal") return isCanonicalPathWithin(pattern.path, candidate)
	return new RegExp(pattern.regex).test(candidate)
}

export type PathPatternError =
	| { readonly kind: "empty-pattern" }
	| { readonly kind: "pattern-too-long"; readonly length: number }
	| { readonly kind: "canonical-path"; readonly input: string; readonly cause: CanonicalPathError }
	| { readonly kind: "glob-too-broad"; readonly input: string }
	| { readonly kind: "unsupported-glob"; readonly input: string; readonly reason: string }

const MAX_PATTERN_LENGTH = 4096
const MINIMATCH_OPTIONS = {
	dot: true,
	nobrace: true,
	nocomment: true,
	noext: true,
	nonegate: true,
	optimizationLevel: 0,
	platform: "darwin",
} as const satisfies MinimatchOptions

/** Parse a literal path or the supported *, **, ?, and character-class glob subset. */
export function parsePathPattern(input: string, relativeTo: CanonicalPath): Result<PathPattern, PathPatternError> {
	if (input.length === 0) return err({ kind: "empty-pattern" })
	if (input.length > MAX_PATTERN_LENGTH) return err({ kind: "pattern-too-long", length: input.length })
	if (containsControlCharacter(input)) {
		return err({ kind: "unsupported-glob", input, reason: "control characters are not supported" })
	}

	const absolutePattern = path.isAbsolute(input) ? path.normalize(input) : path.resolve(relativeTo, input)
	let parsed: Minimatch
	try {
		parsed = new Minimatch(absolutePattern, MINIMATCH_OPTIONS)
	} catch (error) {
		return unsupportedGlob(input, errorMessage(error))
	}

	const row = parsed.set[0]
	const globParts = parsed.globParts[0]
	if (parsed.set.length !== 1 || row === undefined || globParts === undefined) {
		return unsupportedGlob(input, "pattern expansion must produce exactly one pattern")
	}

	if (!parsed.hasMagic()) {
		if (!row.every((part) => typeof part === "string")) {
			return unsupportedGlob(input, "literal pattern contained an unexpected matcher")
		}
		return parseLiteralPattern(row.join("/"), input)
	}

	const firstMagic = row.findIndex((part) => typeof part !== "string")
	if (firstMagic <= 1) return err({ kind: "glob-too-broad", input })

	const staticParts = row.slice(0, firstMagic)
	if (!staticParts.every((part) => typeof part === "string")) {
		return unsupportedGlob(input, "glob static base contained an unexpected matcher")
	}
	const staticBaseInput = staticParts.join("/")
	const staticBaseResult = parseCanonicalPath(staticBaseInput)
	if (!staticBaseResult.ok) return err({ kind: "canonical-path", input, cause: staticBaseResult.error })
	if (containsGlobSyntax(staticBaseResult.value)) {
		return unsupportedGlob(input, "canonical glob base contains glob syntax")
	}

	const suffix = globParts.slice(firstMagic).join("/")
	if (suffix.includes("\\") || suffix.includes("{") || suffix.includes("}")) {
		return unsupportedGlob(input, "escaped characters and brace expansion are not supported in the glob suffix")
	}

	const canonicalPattern = `${staticBaseResult.value}/${suffix}`
	let regex: RegExp
	try {
		regex = globToRegExp(canonicalPattern, { extended: true, globstar: true })
	} catch (error) {
		return unsupportedGlob(input, errorMessage(error))
	}
	if (regex.flags.length !== 0) return unsupportedGlob(input, "regular expression flags are not supported")
	const seatbeltRegex = seatbeltRegexSource(regex)
	if (seatbeltRegex === undefined) {
		return unsupportedGlob(input, "glob library emitted constructs unsupported by Seatbelt")
	}

	return ok(
		Object.freeze({
			kind: "glob",
			pattern: canonicalPattern,
			regex: seatbeltRegex,
			staticBase: staticBaseResult.value,
		}) as PathPattern,
	)
}

function parseLiteralPattern(absolutePath: string, input: string): Result<PathPattern, PathPatternError> {
	const parsed = parseCanonicalPath(absolutePath)
	if (!parsed.ok) return err({ kind: "canonical-path", input, cause: parsed.error })
	return ok(Object.freeze({ kind: "literal", path: parsed.value }) as PathPattern)
}

function unsupportedGlob(input: string, reason: string): Result<never, PathPatternError> {
	return err({ kind: "unsupported-glob", input, reason })
}

/** Seatbelt's regex dialect accepts capture groups but not JavaScript's non-capturing `(?:...)` form. */
function seatbeltRegexSource(regex: RegExp): CompiledPathRegex | undefined {
	const source = regex.source.replaceAll("(?:", "(")
	return source.includes("(?") ? undefined : (source as CompiledPathRegex)
}

function containsControlCharacter(input: string): boolean {
	for (const character of input) {
		const codePoint = character.codePointAt(0)
		if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
	}
	return false
}

function containsGlobSyntax(input: string): boolean {
	return /[*?[\]{}]/.test(input)
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

import { constants, accessSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { type CanonicalPath, type CanonicalPathError, parseCanonicalPath } from "./canonical-path"
import { type Result, err, ok } from "./result"

const NARROW_NO_BREAK_SPACE = "\u202F"
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

export type BuiltinToolPathError =
	| { readonly kind: "path-syntax"; readonly input: string; readonly reason: string }
	| { readonly kind: "canonical-path"; readonly input: string; readonly cause: CanonicalPathError }

/** Resolve a prepared built-in path with the same lexical rules used by Pi 0.80.5. */
export function resolveBuiltinToolPath(
	input: string,
	cwd: CanonicalPath,
	home: CanonicalPath,
	mode: "read" | "write-target",
): Result<CanonicalPath, BuiltinToolPathError> {
	const lexical = resolveLexicalPath(input, cwd, home)
	if (!lexical.ok) return lexical
	const selected = mode === "read" ? selectReadFallback(lexical.value) : lexical.value
	const canonical = parseCanonicalPath(selected)
	return canonical.ok ? canonical : err({ kind: "canonical-path", input, cause: canonical.error })
}

function resolveLexicalPath(
	input: string,
	cwd: CanonicalPath,
	home: CanonicalPath,
): Result<string, Extract<BuiltinToolPathError, { kind: "path-syntax" }>> {
	let normalized = input.replace(UNICODE_SPACES, " ")
	if (normalized.startsWith("@")) normalized = normalized.slice(1)
	if (normalized === "~") normalized = home
	else if (normalized.startsWith("~/")) normalized = path.join(home, normalized.slice(2))

	if (normalized.startsWith("file://")) {
		try {
			normalized = fileURLToPath(normalized)
		} catch (error) {
			return err({
				kind: "path-syntax",
				input,
				reason: error instanceof Error ? error.message : String(error),
			})
		}
	}
	return ok(path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized))
}

function selectReadFallback(resolved: string): string {
	if (exists(resolved)) return resolved

	const amPm = resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`)
	if (amPm !== resolved && exists(amPm)) return amPm

	const nfd = resolved.normalize("NFD")
	if (nfd !== resolved && exists(nfd)) return nfd

	const curly = resolved.replaceAll("'", "\u2019")
	if (curly !== resolved && exists(curly)) return curly

	const nfdCurly = nfd.replaceAll("'", "\u2019")
	if (nfdCurly !== resolved && exists(nfdCurly)) return nfdCurly

	return resolved
}

function exists(input: string): boolean {
	try {
		accessSync(input, constants.F_OK)
		return true
	} catch {
		return false
	}
}

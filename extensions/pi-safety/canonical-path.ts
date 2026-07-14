import * as fs from "node:fs"
import * as path from "node:path"
import { type Result, err, ok } from "./result"

declare const canonicalPathBrand: unique symbol
declare const canonicalExecutableBrand: unique symbol
declare const lexicalAbsolutePathBrand: unique symbol

export type CanonicalPath = string & { readonly [canonicalPathBrand]: true }
export type CanonicalExecutable = CanonicalPath & { readonly [canonicalExecutableBrand]: true }
export type LexicalAbsolutePath = string & { readonly [lexicalAbsolutePathBrand]: true }
export type SeatbeltPath = CanonicalPath | LexicalAbsolutePath

export type CanonicalPathError =
	| { readonly kind: "not-absolute"; readonly input: string }
	| { readonly kind: "nul-byte"; readonly input: string }
	| { readonly kind: "dangling-symlink"; readonly input: string; readonly path: string }
	| { readonly kind: "filesystem"; readonly input: string; readonly path: string; readonly code?: string }

export type CanonicalPathAppendError = { readonly kind: "invalid-relative-components" }

export type CanonicalExecutableError =
	| CanonicalPathError
	| { readonly kind: "not-file"; readonly path: CanonicalPath }
	| { readonly kind: "not-executable"; readonly path: CanonicalPath; readonly code?: string }

/**
 * Resolve an absolute path through its nearest existing ancestor.
 *
 * Existing components are resolved with realpath. Missing trailing components are
 * appended to that canonical ancestor. A dangling symlink is rejected rather than
 * treated as an ordinary missing component because its eventual destination is unknown.
 */
export function parseCanonicalPath(input: string): Result<CanonicalPath, CanonicalPathError> {
	if (!path.isAbsolute(input)) return err({ kind: "not-absolute", input })
	if (input.includes("\0")) return err({ kind: "nul-byte", input })

	let candidate = path.normalize(input)
	const missingComponents: string[] = []

	while (true) {
		try {
			const existingAncestor = fs.realpathSync.native(candidate)
			const resolved = path.join(existingAncestor, ...missingComponents)
			return ok(resolved as CanonicalPath)
		} catch (error) {
			if (errorCode(error) === "EOPNOTSUPP") {
				let unsupportedLeaf: fs.Stats
				try {
					unsupportedLeaf = fs.lstatSync(candidate)
				} catch (statError) {
					return err({ kind: "filesystem", input, path: candidate, code: errorCode(statError) })
				}
				if (unsupportedLeaf.isSocket()) {
					missingComponents.unshift(path.basename(candidate))
					candidate = path.dirname(candidate)
					continue
				}
			}
			if (errorCode(error) !== "ENOENT") {
				return err({ kind: "filesystem", input, path: candidate, code: errorCode(error) })
			}
		}

		try {
			if (fs.lstatSync(candidate).isSymbolicLink()) {
				return err({ kind: "dangling-symlink", input, path: candidate })
			}
		} catch (error) {
			if (errorCode(error) !== "ENOENT") {
				return err({ kind: "filesystem", input, path: candidate, code: errorCode(error) })
			}
		}

		const parent = path.dirname(candidate)
		if (parent === candidate) return err({ kind: "filesystem", input, path: candidate })
		missingComponents.unshift(path.basename(candidate))
		candidate = parent
	}
}

/** Append already parsed relative path components without consulting mutable filesystem state. */
export function appendCanonicalPath(
	root: CanonicalPath,
	components: readonly string[],
): Result<CanonicalPath, CanonicalPathAppendError> {
	if (
		components.length === 0 ||
		components.some(
			(component) =>
				component.length === 0 ||
				component === "." ||
				component === ".." ||
				component.includes(path.sep) ||
				component.includes("\0"),
		)
	) {
		return err({ kind: "invalid-relative-components" })
	}
	return ok(path.join(root, ...components) as CanonicalPath)
}

/** True when candidate is root itself or a descendant on a path-component boundary. */
export function isCanonicalPathWithin(root: CanonicalPath, candidate: CanonicalPath): boolean {
	const relative = path.relative(root, candidate)
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function canonicalAncestors(input: CanonicalPath): readonly CanonicalPath[] {
	const ancestors: CanonicalPath[] = []
	let current = path.dirname(input)
	while (current !== path.parse(current).root) {
		ancestors.push(current as CanonicalPath)
		current = path.dirname(current)
	}
	return Object.freeze(ancestors)
}

export function parseLexicalAbsolutePath(input: string): Result<LexicalAbsolutePath, CanonicalPathError> {
	if (!path.isAbsolute(input)) return err({ kind: "not-absolute", input })
	if (input.includes("\0")) return err({ kind: "nul-byte", input })
	return ok(path.normalize(input) as LexicalAbsolutePath)
}

/** Seatbelt sometimes reports macOS symlink aliases instead of their canonical /private paths. */
export function seatbeltPathAliases(input: CanonicalPath): readonly LexicalAbsolutePath[] {
	const aliases: LexicalAbsolutePath[] = []
	for (const prefix of ["/private/tmp", "/private/var"]) {
		if (input === prefix || input.startsWith(`${prefix}${path.sep}`)) {
			const parsed = parseLexicalAbsolutePath(input.slice("/private".length))
			if (!parsed.ok) throw new TypeError("failed to derive a Seatbelt path alias")
			aliases.push(parsed.value)
		}
	}
	return Object.freeze(aliases)
}

export function parseCanonicalExecutable(input: string): Result<CanonicalExecutable, CanonicalExecutableError> {
	const parsed = parseCanonicalPath(input)
	if (!parsed.ok) return parsed

	let stats: fs.Stats
	try {
		stats = fs.statSync(parsed.value)
	} catch (error) {
		return err({ kind: "filesystem", input, path: parsed.value, code: errorCode(error) })
	}
	if (!stats.isFile()) return err({ kind: "not-file", path: parsed.value })

	try {
		fs.accessSync(parsed.value, fs.constants.X_OK)
	} catch (error) {
		return err({ kind: "not-executable", path: parsed.value, code: errorCode(error) })
	}

	return ok(parsed.value as CanonicalExecutable)
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined
	return typeof error.code === "string" ? error.code : undefined
}

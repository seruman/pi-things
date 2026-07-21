import * as fs from "node:fs"
import * as path from "node:path"
import { z } from "zod"
import type { CanonicalPath } from "./canonical-path"
import { parseCanonicalPath } from "./canonical-path"
import { type Result, err, ok } from "./result"

export type SessionPathAccess = "read-only" | "read-write"

export type SessionPathGrant = {
	readonly path: CanonicalPath
	readonly access: SessionPathAccess
}

export type SessionPathError = {
	readonly kind: "invalid-session-path"
	readonly path: string
	readonly message: string
}

const environmentSchema = z
	.array(
		z
			.object({
				path: z.string().min(1),
				access: z.enum(["read-only", "read-write"]),
			})
			.strict(),
	)
	.readonly()

export function parseSessionPathGrant(input: {
	readonly path: string
	readonly access: SessionPathAccess
	readonly home: string
	readonly allowTilde?: boolean
}): Result<SessionPathGrant, SessionPathError> {
	const expanded = input.allowTilde ? expandTilde(input.path.trim(), input.home) : input.path.trim()
	if (!path.isAbsolute(expanded)) return invalid(input.path, "expected an absolute directory path")
	const canonical = parseCanonicalPath(expanded)
	if (!canonical.ok) return invalid(input.path, `path resolution failed (${canonical.error.kind})`)
	let stat: fs.Stats
	try {
		stat = fs.statSync(canonical.value)
	} catch (cause) {
		return invalid(input.path, cause instanceof Error ? cause.message : String(cause))
	}
	if (!stat.isDirectory()) return invalid(input.path, "expected an existing directory")
	return ok(Object.freeze({ path: canonical.value, access: input.access }))
}

export function parseSessionPathsEnvironment(
	input: string | undefined,
	home: string,
): Result<readonly SessionPathGrant[], SessionPathError> {
	if (!input) return ok([])
	let decoded: unknown
	try {
		decoded = JSON.parse(input)
	} catch (cause) {
		return invalid("PI_SAFETY_SESSION_PATHS", cause instanceof Error ? cause.message : String(cause))
	}
	const parsed = environmentSchema.safeParse(decoded)
	if (!parsed.success)
		return invalid("PI_SAFETY_SESSION_PATHS", parsed.error.issues.map((issue) => issue.message).join("; "))
	const grants: SessionPathGrant[] = []
	for (const entry of parsed.data) {
		const grant = parseSessionPathGrant({ ...entry, home })
		if (!grant.ok) return grant
		const existing = grants.findIndex((candidate) => candidate.path === grant.value.path)
		if (existing >= 0) grants.splice(existing, 1)
		grants.push(grant.value)
	}
	return ok(Object.freeze(grants))
}

function expandTilde(input: string, home: string): string {
	return input === "~" ? home : input.startsWith("~/") ? path.join(home, input.slice(2)) : input
}

function invalid(pathname: string, message: string): Result<never, SessionPathError> {
	return err({ kind: "invalid-session-path", path: pathname, message })
}

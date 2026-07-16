import { constants } from "node:fs"
import { access, chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { type Result, err, ok } from "./result"

export type ShimSessionError =
	| { readonly kind: "missing-executable"; readonly executable: "bun" | "git" }
	| { readonly kind: "setup-failed"; readonly message: string }
	| { readonly kind: "cleanup-refused"; readonly path: string }
	| { readonly kind: "cleanup-failed"; readonly message: string }

export type ShimSession = {
	readonly root: string
	readonly shimDirectory: string
	readonly path: string
	readonly realExecutables: { readonly git: string; readonly gh?: string }
	cleanup(): Promise<Result<undefined, ShimSessionError>>
}

export async function prepareShimSession(input: {
	readonly privateRoot: string
	readonly path: string
	readonly shimEntry: string
	readonly executables?: { readonly bun?: string; readonly git?: string; readonly gh?: string }
}): Promise<Result<ShimSession, ShimSessionError>> {
	const bun = await resolveExecutable("bun", input.executables?.bun, input.path)
	if (!bun) return err({ kind: "missing-executable", executable: "bun" })
	const git = await resolveExecutable("git", input.executables?.git, input.path)
	if (!git) return err({ kind: "missing-executable", executable: "git" })
	const gh = await resolveExecutable("gh", input.executables?.gh, input.path)

	let root: string
	try {
		root = await mkdtemp(path.join(input.privateRoot, "shell-leash-"))
		await chmod(root, 0o700)
		await writeLauncher(path.join(root, "git"), bun, input.shimEntry, "git")
		if (gh) await writeLauncher(path.join(root, "gh"), bun, input.shimEntry, "gh")
	} catch (cause) {
		return err({ kind: "setup-failed", message: errorMessage(cause) })
	}

	return ok({
		root,
		shimDirectory: root,
		path: `${root}${path.delimiter}${input.path}`,
		realExecutables: { git, ...(gh ? { gh } : {}) },
		cleanup: async () => cleanupShimSession(input.privateRoot, root),
	})
}

async function resolveExecutable(
	name: string,
	configured: string | undefined,
	searchPath: string,
): Promise<string | undefined> {
	if (configured) {
		try {
			await access(configured, constants.X_OK)
			return await realpath(configured)
		} catch {
			return undefined
		}
	}
	return findExecutable(name, searchPath)
}

async function findExecutable(name: string, searchPath: string): Promise<string | undefined> {
	for (const directory of searchPath.split(path.delimiter)) {
		if (!directory) continue
		const candidate = path.join(directory, name)
		try {
			await access(candidate, constants.X_OK)
			return await realpath(candidate)
		} catch {
			// Keep searching PATH entries. Absence is represented by undefined.
		}
	}
	return undefined
}

async function writeLauncher(launcherPath: string, bun: string, shimEntry: string, tool: "git" | "gh"): Promise<void> {
	const source = `#!/bin/sh\nexec ${shellQuote(bun)} ${shellQuote(shimEntry)} ${tool} "$@"\n`
	await writeFile(launcherPath, source, { mode: 0o700, flag: "wx" })
}

async function cleanupShimSession(privateRoot: string, root: string): Promise<Result<undefined, ShimSessionError>> {
	if (path.dirname(root) !== path.resolve(privateRoot) || !path.basename(root).startsWith("shell-leash-")) {
		return err({ kind: "cleanup-refused", path: root })
	}
	try {
		await rm(root, { recursive: true, force: true })
		return ok(undefined)
	} catch (cause) {
		return err({ kind: "cleanup-failed", message: errorMessage(cause) })
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

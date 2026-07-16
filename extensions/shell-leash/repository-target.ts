import type { Stats } from "node:fs"
import { readFile, realpath, stat } from "node:fs/promises"
import * as path from "node:path"
import type { RepositoryTarget } from "./effects"
import { type Result, err, ok } from "./result"

export type RepositoryContext = {
	readonly repository: RepositoryTarget
	readonly remotes: ReadonlyMap<string, string>
	readonly currentBranch?: string
	readonly defaultPushRemote?: string
}

export type RepositoryTargetError =
	| { readonly kind: "cwd"; readonly path: string; readonly message: string }
	| { readonly kind: "git-metadata"; readonly path: string; readonly message: string }

export async function resolveRepositoryTarget(cwd: string): Promise<Result<RepositoryTarget, RepositoryTargetError>> {
	const context = await resolveRepositoryContext(cwd)
	return context.ok ? ok(context.value.repository) : context
}

export async function resolveRepositoryContext(cwd: string): Promise<Result<RepositoryContext, RepositoryTargetError>> {
	let current: string
	try {
		current = await realpath(cwd)
	} catch (cause) {
		return err({ kind: "cwd", path: cwd, message: errorMessage(cause) })
	}
	while (true) {
		const dotGit = path.join(current, ".git")
		const metadata = await findGitMetadata(dotGit)
		if (!metadata.ok) return metadata
		if (metadata.value) {
			let source: string
			try {
				source = await readFile(metadata.value.config, "utf8")
			} catch (cause) {
				return err({ kind: "git-metadata", path: metadata.value.config, message: errorMessage(cause) })
			}
			const remotes = remoteUrls(source)
			const branch = await currentBranch(metadata.value.gitDirectory)
			if (!branch.ok) return branch
			const defaultPushRemote = preferredPushRemote(source, branch.value)
			const remoteUrl = remotes.get(defaultPushRemote ?? "origin")
			return ok({
				repository: remoteUrl ? parseRepositoryUrl(remoteUrl) : { kind: "unknown" },
				remotes,
				...(branch.value ? { currentBranch: branch.value } : {}),
				...(defaultPushRemote ? { defaultPushRemote } : {}),
			})
		}
		const parent = path.dirname(current)
		if (parent === current) return ok({ repository: { kind: "unknown" }, remotes: new Map() })
		current = parent
	}
}

async function findGitMetadata(
	dotGit: string,
): Promise<Result<{ readonly config: string; readonly gitDirectory: string } | undefined, RepositoryTargetError>> {
	let metadata: Stats
	try {
		metadata = await stat(dotGit)
	} catch (cause) {
		return isNodeError(cause) && cause.code === "ENOENT"
			? ok(undefined)
			: err({ kind: "git-metadata", path: dotGit, message: errorMessage(cause) })
	}
	if (metadata.isDirectory()) return ok({ config: path.join(dotGit, "config"), gitDirectory: dotGit })
	if (!metadata.isFile()) return ok(undefined)
	let pointer: string
	try {
		pointer = await readFile(dotGit, "utf8")
	} catch (cause) {
		return err({ kind: "git-metadata", path: dotGit, message: errorMessage(cause) })
	}
	const match = /^gitdir:\s*(.+)\s*$/im.exec(pointer)
	if (!match?.[1]) return ok(undefined)
	const gitDirectory = path.resolve(path.dirname(dotGit), match[1])
	let commonDirectory = gitDirectory
	try {
		const common = (await readFile(path.join(gitDirectory, "commondir"), "utf8")).trim()
		if (common) commonDirectory = path.resolve(gitDirectory, common)
	} catch (cause) {
		if (!isNodeError(cause) || cause.code !== "ENOENT") {
			return err({ kind: "git-metadata", path: gitDirectory, message: errorMessage(cause) })
		}
	}
	return ok({ config: path.join(commonDirectory, "config"), gitDirectory })
}

async function currentBranch(gitDirectory: string): Promise<Result<string | undefined, RepositoryTargetError>> {
	const headPath = path.join(gitDirectory, "HEAD")
	let head: string
	try {
		head = await readFile(headPath, "utf8")
	} catch (cause) {
		return isNodeError(cause) && cause.code === "ENOENT"
			? ok(undefined)
			: err({ kind: "git-metadata", path: headPath, message: errorMessage(cause) })
	}
	const match = /^ref:\s*refs\/heads\/(.+)\s*$/.exec(head)
	return ok(match?.[1])
}

function preferredPushRemote(source: string, branch: string | undefined): string | undefined {
	let section: { readonly kind: "branch"; readonly name: string } | { readonly kind: "remote-default" } | undefined
	let remoteDefault: string | undefined
	let branchRemote: string | undefined
	let branchPushRemote: string | undefined
	for (const line of source.split("\n")) {
		const branchSection = /^\s*\[branch\s+"([^"]+)"\]\s*$/i.exec(line)
		if (branchSection?.[1]) {
			section = { kind: "branch", name: branchSection[1] }
			continue
		}
		if (/^\s*\[remote\]\s*$/i.test(line)) {
			section = { kind: "remote-default" }
			continue
		}
		if (/^\s*\[/.test(line)) {
			section = undefined
			continue
		}
		const setting = /^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/.exec(line)
		if (!setting?.[1] || !setting[2]) continue
		if (section?.kind === "remote-default" && setting[1].toLowerCase() === "pushdefault") {
			remoteDefault = setting[2]
		}
		if (section?.kind === "branch" && section.name === branch) {
			if (setting[1].toLowerCase() === "pushremote") branchPushRemote = setting[2]
			if (setting[1].toLowerCase() === "remote" && setting[2] !== ".") branchRemote = setting[2]
		}
	}
	return branchPushRemote ?? remoteDefault ?? branchRemote
}

function remoteUrls(source: string): ReadonlyMap<string, string> {
	const urls = new Map<string, { url?: string; pushUrl?: string }>()
	let remote: string | undefined
	for (const line of source.split("\n")) {
		const section = /^\s*\[remote\s+"([^"]+)"\]\s*$/i.exec(line)
		if (section?.[1]) {
			remote = section[1]
			if (!urls.has(remote)) urls.set(remote, {})
			continue
		}
		if (/^\s*\[/.test(line)) {
			remote = undefined
			continue
		}
		if (!remote) continue
		const setting = /^\s*(url|pushurl)\s*=\s*(.*?)\s*$/i.exec(line)
		const value = setting?.[2]
		if (!value) continue
		const current = urls.get(remote) ?? {}
		urls.set(
			remote,
			setting?.[1]?.toLowerCase() === "pushurl" ? { ...current, pushUrl: value } : { ...current, url: value },
		)
	}
	const output = new Map<string, string>()
	for (const [name, values] of urls) {
		const value = values.pushUrl ?? values.url
		if (value) output.set(name, value)
	}
	return output
}

export function parseRepositoryUrl(input: string): RepositoryTarget {
	const scp = /^(?:[^@]+@)?([^:]+):([^/]+)\/(.+)$/.exec(input)
	if (scp?.[1] && scp[2] && scp[3]) {
		return { kind: "repository", host: scp[1], owner: scp[2], repository: stripGitSuffix(scp[3]) }
	}
	let url: URL
	try {
		url = new URL(input)
	} catch {
		return { kind: "unknown" }
	}
	const [owner, repository] = url.pathname.replace(/^\/+/, "").split("/")
	return owner && repository
		? { kind: "repository", host: url.hostname, owner, repository: stripGitSuffix(repository) }
		: { kind: "unknown" }
}

function stripGitSuffix(input: string): string {
	return input.replace(/\.git$/, "")
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

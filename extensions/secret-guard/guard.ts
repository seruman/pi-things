import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import ignore, { type Ignore } from "ignore"

export const USER_PROTECT_FILE = path.join(os.homedir(), ".pi", "agent", "secret-guard.protect")
export const PROJECT_PROTECT_FILES = [".pi/secret-guard.protect"] as const

export const DEFAULT_PATTERNS = [
	"# dotenv files",
	".env",
	".env.*",
	"!.env.example",
	"!.env.sample",
	"!.env.template",
	"",
	"# private keys and local credential material",
	"*.pem",
	"*.key",
	"id_rsa",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
	"*.kubeconfig",
	"kubeconfig",
	"",
	"# common secret directories",
	".aws/",
	".azure/",
	".gcp/",
	".gnupg/",
	".ssh/",
	"secrets/",
] as const

type RuleSet = {
	root: string
	patterns: string[]
	matcher: Ignore
}

export type SecretGuardConfig = {
	root: string
	projectRoot: string
	protectFiles: string[]
	ruleSets: RuleSet[]
}

export type MatchResult = {
	blocked: boolean
	path: string
	absolutePath: string
	relativePath: string
	matchedBy: string[]
}

function toPosix(filePath: string) {
	return filePath.split(path.sep).join("/")
}

function isInside(root: string, absolutePath: string) {
	const relativePath = path.relative(root, absolutePath)
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
}

function relativeForRoot(root: string, absolutePath: string) {
	return isInside(root, absolutePath)
		? toPosix(path.relative(root, absolutePath) || path.basename(absolutePath))
		: undefined
}

function readProtectFile(filePath: string) {
	try {
		return fs.readFileSync(filePath, "utf-8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw error
	}
}

export function nearestProjectRoot(cwd: string): string {
	let dir = path.resolve(cwd)
	while (true) {
		for (const name of PROJECT_PROTECT_FILES) {
			const candidate = path.join(dir, name)
			try {
				if (fs.statSync(candidate).isFile()) return dir
			} catch {
				// ignore
			}
		}
		const parent = path.dirname(dir)
		if (parent === dir) return path.resolve(cwd)
		dir = parent
	}
}

function ruleSet(root: string, patterns: string[]): RuleSet {
	return {
		root,
		patterns,
		matcher: ignore().add(patterns),
	}
}

export function loadSecretGuardConfig(cwd: string): SecretGuardConfig {
	const root = path.resolve(cwd)
	const projectRoot = nearestProjectRoot(root)
	const protectFiles: string[] = []
	const ruleSets: RuleSet[] = [ruleSet(path.parse(root).root, [...DEFAULT_PATTERNS])]

	const userContents = readProtectFile(USER_PROTECT_FILE)
	if (userContents !== undefined) {
		protectFiles.push(USER_PROTECT_FILE)
		ruleSets.push(ruleSet(os.homedir(), userContents.split(/\r?\n/)))
	}

	for (const name of PROJECT_PROTECT_FILES) {
		const filePath = path.join(projectRoot, name)
		const contents = readProtectFile(filePath)
		if (contents === undefined) continue
		protectFiles.push(filePath)
		ruleSets.push(ruleSet(projectRoot, contents.split(/\r?\n/)))
	}

	return { root, projectRoot, protectFiles, ruleSets }
}

export function matchProtectedRead(config: SecretGuardConfig, requestedPath: string): MatchResult {
	const absolutePath = path.resolve(config.root, requestedPath)
	const realPath = realpathIfExists(absolutePath)
	const fallbackRelativePath = toPosix(path.relative(config.projectRoot, realPath ?? absolutePath))
	const matchedBy = new Set<string>()

	const checkPath = (candidate: string) => {
		for (const rules of config.ruleSets) {
			const relativePath = relativeForRoot(rules.root, candidate)
			if (!relativePath || !rules.matcher.ignores(relativePath)) continue
			for (const pattern of matchingPatterns(rules.patterns, relativePath)) matchedBy.add(pattern)
		}
	}

	checkPath(absolutePath)
	if (realPath && realPath !== absolutePath) checkPath(realPath)

	return {
		blocked: matchedBy.size > 0,
		path: requestedPath,
		absolutePath,
		relativePath: fallbackRelativePath,
		matchedBy: [...matchedBy],
	}
}

function realpathIfExists(filePath: string) {
	try {
		return fs.realpathSync.native(filePath)
	} catch {
		return undefined
	}
}

function matchingPatterns(patterns: string[], relativePath: string) {
	const matched: string[] = []
	for (const pattern of patterns) {
		const trimmed = pattern.trim()
		if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue
		try {
			if (ignore().add([pattern]).ignores(relativePath) && !matched.includes(pattern)) {
				matched.push(pattern)
			}
		} catch {
			// Ignore invalid diagnostics here. The main matcher will surface invalid patterns during load.
		}
	}
	return matched
}

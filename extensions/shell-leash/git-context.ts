import * as path from "node:path"
import type { StaticWord } from "./static-word"

export function gitEnvironmentCwd(cwd: string, workTree?: string, gitDirectory?: string): string {
	if (workTree) return path.resolve(cwd, workTree)
	if (!gitDirectory) return cwd
	const resolved = path.resolve(cwd, gitDirectory)
	return path.basename(resolved) === ".git" ? path.dirname(resolved) : cwd
}

export function staticGitInvocationCwd(argv: readonly StaticWord[], cwd: string): string {
	const resolvedPrefix: string[] = []
	for (const word of argv) {
		if (word.kind !== "literal") break
		resolvedPrefix.push(word.value)
	}
	return gitInvocationCwd(resolvedPrefix, cwd)
}

export function gitInvocationCwd(argv: readonly string[], cwd: string): string {
	if (path.basename(argv[0] ?? "") !== "git") return cwd
	let effective = cwd
	let workTree: string | undefined
	let gitDirectory: string | undefined
	for (let index = 1; index < argv.length; index++) {
		const arg = argv[index]
		if (arg === "-C") {
			const value = argv[index + 1]
			if (value === undefined) return effective
			effective = path.resolve(effective, value)
			index++
			continue
		}
		if (arg?.startsWith("-C") && arg.length > 2) {
			effective = path.resolve(effective, arg.slice(2))
			continue
		}
		if (arg === "--git-dir" || arg === "--work-tree") {
			const value = argv[index + 1]
			if (value === undefined) break
			if (arg === "--work-tree") workTree = path.resolve(effective, value)
			else gitDirectory = path.resolve(effective, value)
			index++
			continue
		}
		if (arg?.startsWith("--git-dir=")) {
			gitDirectory = path.resolve(effective, arg.slice("--git-dir=".length))
			continue
		}
		if (arg?.startsWith("--work-tree=")) {
			workTree = path.resolve(effective, arg.slice("--work-tree=".length))
			continue
		}
		if (["-c", "--namespace"].includes(arg ?? "")) {
			index++
			continue
		}
		if (arg?.startsWith("-")) continue
		break
	}
	if (workTree) return workTree
	return gitDirectory && path.basename(gitDirectory) === ".git" ? path.dirname(gitDirectory) : effective
}

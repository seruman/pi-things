import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import type { SettingsManager } from "@earendil-works/pi-coding-agent"
import { minimatch } from "minimatch"

const posix = (path: string) => path.replaceAll("\\", "/")
const exactPattern = (path: string) => posix(path).replace(/^\.\//, "")

export function assertConfiguredExtensionsExist(settings: SettingsManager, cwd: string, agentDir: string): void {
	for (const [base, paths] of [
		[agentDir, settings.getGlobalSettings().extensions ?? []],
		[join(cwd, ".pi"), settings.getProjectSettings().extensions ?? []],
	] as const) {
		const globs = paths.filter((entry) => !/^[!+-]/.test(entry) && /[*?{}[\]]/.test(entry))
		for (const path of paths) {
			if (/^[!+-]/.test(path) || !/\.(ts|js)$/.test(path) || /[*?{}[\]]/.test(path)) continue
			const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path
			const absolute = isAbsolute(expanded) ? expanded : resolve(base, expanded)
			if (existsSync(absolute)) continue
			const rel = posix(relative(base, absolute))
			const full = posix(absolute)
			const matchesGlob = (pattern: string) =>
				[rel, basename(absolute), full].some((value) => minimatch(value, posix(pattern)))
			const matchesExact = (pattern: string) => [rel, full].includes(exactPattern(pattern))
			let enabled = globs.length === 0 || globs.some(matchesGlob)
			if (paths.some((entry) => entry.startsWith("!") && matchesGlob(entry.slice(1)))) enabled = false
			if (paths.some((entry) => entry.startsWith("+") && matchesExact(entry.slice(1)))) enabled = true
			if (paths.some((entry) => entry.startsWith("-") && matchesExact(entry.slice(1)))) enabled = false
			if (enabled) throw new Error(`Required extension path does not exist: ${absolute}`)
		}
	}
}

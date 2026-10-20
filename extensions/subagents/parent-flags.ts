import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { parseArgs } from "@earendil-works/pi-coding-agent"

/** Inherit extension selection, not the parent's session, prompt, or execution mode. */
export function parentExtensionFlags(argv: string[], cwd: string): string[] {
	const parsed = parseArgs(argv)
	const flags: string[] = []

	if (parsed.noExtensions) flags.push("--no-extensions")
	const sources = new Set<string>()

	for (const source of parsed.extensions ?? []) {
		const expanded = source === "~" ? homedir() : source.startsWith("~/") ? resolve(homedir(), source.slice(2)) : source
		const absolute = resolve(cwd, expanded)
		// Existing local sources were validated by the parent. Anchor them before a child
		// changes cwd; leave builtin:, npm:, and Git package sources for Pi to resolve.
		const inherited = existsSync(absolute) ? absolute : source

		if (sources.has(inherited)) continue
		sources.add(inherited)
		flags.push("--extension", inherited)
	}

	return flags
}

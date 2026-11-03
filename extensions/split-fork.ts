// Adapted from https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/split-fork.ts
// Original work licensed under the Apache License 2.0 (Apache-2.0).

import { existsSync, readFileSync } from "node:fs"
import * as path from "node:path"
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	SessionManager,
	getPackageDir,
} from "@earendil-works/pi-coding-agent"
import type { AutocompleteItem } from "@earendil-works/pi-tui"
import { z } from "zod"

const VALID_DIRECTIONS = ["right", "left", "down", "up"] as const

const DEFAULT_DIRECTION = "right"

export type SplitDirection = (typeof VALID_DIRECTIONS)[number]

export type SplitLaunchResult = { ok: true; terminalName: string } | { ok: false; terminalName: string; reason: string }

type SplitExecutor = Pick<ExtensionAPI, "exec">

type SplitContext = Pick<ExtensionCommandContext, "cwd">

type SplitForkArgs = { direction: SplitDirection; prompt: string }

const packageNameSchema = z.object({ piConfig: z.object({ name: z.string().optional() }).optional() })

function shellQuote(value: string): string {
	if (value.length === 0) return "''"

	return `'${value.replace(/'/g, `'"'"'`)}'`
}

export function isRexSession(): boolean {
	return Boolean(process.env.REX_SERVER?.trim() && process.env.REX_BLOCK?.trim())
}

/** Pi takes its command name from `piConfig.name` in its package.json, but does not export it. */
export function resolveAppName(packageDir: string): string {
	try {
		const pkg = packageNameSchema.parse(JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")))

		return pkg.piConfig?.name || "pi"
	} catch {
		return "pi"
	}
}

export function resolvePiInvocation(
	execPath: string,
	currentScript: string | undefined,
	currentScriptExists: boolean,
	appName = "pi",
): string[] {
	if (appName !== "pi") return [appName]
	const execName = path.basename(execPath).toLowerCase()
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)

	if (!isGenericRuntime) return [execPath]

	if (currentScript && currentScriptExists) return [execPath, currentScript]

	return [appName]
}

export function getPiInvocationParts(): string[] {
	const currentScript = process.argv[1]
	const appName = resolveAppName(getPackageDir())

	return resolvePiInvocation(
		process.execPath,
		currentScript,
		Boolean(currentScript && existsSync(currentScript)),
		appName,
	)
}

export function buildPiStartupInput(
	sessionFile: string | undefined,
	prompt: string,
	extensionFiles: readonly string[] = [],
): string {
	const commandParts = [...getPiInvocationParts()]

	for (const extensionFile of extensionFiles) {
		commandParts.push("-e", extensionFile)
	}

	if (sessionFile) {
		commandParts.push("--session", sessionFile)
	}

	if (prompt.length > 0) {
		commandParts.push(prompt)
	}

	return `${commandParts.map(shellQuote).join(" ")}\n`
}

function isSplitDirection(value: string): value is SplitDirection {
	return VALID_DIRECTIONS.some((direction) => direction === value)
}

export function parseSplitForkArgs(raw: string): SplitForkArgs {
	const trimmed = raw.trim()

	if (!trimmed) {
		return { direction: DEFAULT_DIRECTION, prompt: "" }
	}

	if (!trimmed.startsWith("-")) {
		return { direction: DEFAULT_DIRECTION, prompt: trimmed }
	}

	if (trimmed.startsWith("-d=")) {
		const withoutFlag = trimmed.slice(3)
		const firstSpace = withoutFlag.search(/\s/)
		const value = (firstSpace === -1 ? withoutFlag : withoutFlag.slice(0, firstSpace)).trim()
		const prompt = firstSpace === -1 ? "" : withoutFlag.slice(firstSpace).trim()

		if (!value) {
			throw new Error("Missing value for -d. Expected one of: right, left, down, up.")
		}

		if (!isSplitDirection(value)) {
			throw new Error(`Invalid direction "${value}". Expected one of: right, left, down, up.`)
		}

		return { direction: value, prompt }
	}

	if (trimmed.startsWith("-d")) {
		const match = trimmed.match(/^-d(?:\s+([^\s]+))?(?:\s+(.*))?$/s)
		const value = match?.[1]?.trim() ?? ""
		const prompt = match?.[2]?.trim() ?? ""

		if (!value) {
			throw new Error("Missing value for -d. Expected one of: right, left, down, up.")
		}

		if (!isSplitDirection(value)) {
			throw new Error(`Invalid direction "${value}". Expected one of: right, left, down, up.`)
		}

		return { direction: value, prompt }
	}

	const unknownFlag = trimmed.match(/^(-\S+)/)?.[1]
	throw new Error(`Unknown option: ${unknownFlag ?? trimmed}`)
}

async function launchRexSplit(
	pi: SplitExecutor,
	ctx: SplitContext,
	startupInput: string,
	direction: SplitDirection,
): Promise<SplitLaunchResult> {
	const block = process.env.REX_BLOCK?.trim()

	if (!block) return { ok: false, terminalName: "Rex", reason: "missing REX_BLOCK" }
	const rexDirection = direction === "up" ? "above" : direction === "down" ? "below" : direction

	const result = await pi.exec("rex", [
		"split",
		"--block",
		block,
		"--split",
		rexDirection,
		"--cwd",
		ctx.cwd,
		"--",
		"sh",
		"-c",
		startupInput,
	])

	if (result.code !== 0) {
		return {
			ok: false,
			terminalName: "Rex",
			reason: result.stderr?.trim() || result.stdout?.trim() || "unknown rex error",
		}
	}

	return { ok: true, terminalName: "Rex" }
}

export async function launchTerminalSplit(
	pi: SplitExecutor,
	ctx: SplitContext,
	startupInput: string,
	direction: SplitDirection,
): Promise<SplitLaunchResult> {
	if (!isRexSession()) return { ok: false, terminalName: "Rex", reason: "not running inside Rex" }

	return launchRexSplit(pi, ctx, startupInput, direction)
}

export function createClonedSession(ctx: ExtensionCommandContext): string | undefined {
	const sessionFile = ctx.sessionManager.getSessionFile()
	const leafId = ctx.sessionManager.getLeafId()

	if (!sessionFile || !leafId || !existsSync(sessionFile)) return undefined

	// createBranchedSession mutates its SessionManager, so mirror pi's native /clone
	// implementation and operate on a separately opened manager. The original pi
	// process keeps its current manager while the cloned active path opens in the split.
	const clone = SessionManager.open(sessionFile, ctx.sessionManager.getSessionDir())
	const clonedSessionFile = clone.createBranchedSession(leafId)

	// Pi defers writing a branch containing no assistant response. A detached manager
	// cannot flush it later, so treat that edge case as an empty split instead.
	return clonedSessionFile && existsSync(clonedSessionFile) ? clonedSessionFile : undefined
}

function getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const trimmedStart = prefix.trimStart()

	if (trimmedStart.length === 0) {
		return [{ value: "-d ", label: "-d", description: "Choose split direction" }]
	}

	if (trimmedStart.startsWith("-d=")) {
		const valuePrefix = trimmedStart.slice(3)

		if (valuePrefix.includes(" ")) return null
		const matches = VALID_DIRECTIONS.filter((direction) => direction.startsWith(valuePrefix))

		return matches.length > 0 ? matches.map((direction) => ({ value: `-d=${direction}`, label: direction })) : null
	}

	if (trimmedStart === "-d") {
		return VALID_DIRECTIONS.map((direction) => ({ value: `-d ${direction}`, label: direction }))
	}

	const shortFlagMatch = trimmedStart.match(/^-d\s+([^\s]*)$/)

	if (shortFlagMatch) {
		const valuePrefix = shortFlagMatch[1] ?? ""
		const matches = VALID_DIRECTIONS.filter((direction) => direction.startsWith(valuePrefix))

		return matches.length > 0 ? matches.map((direction) => ({ value: `-d ${direction}`, label: direction })) : null
	}

	if (trimmedStart.startsWith("-d ") || trimmedStart.startsWith("-d=")) {
		return null
	}

	if (!trimmedStart.includes(" ") && "-d".startsWith(trimmedStart)) {
		return [{ value: "-d ", label: "-d", description: "Choose split direction" }]
	}

	return null
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("split-fork", {
		description:
			"Clone the active session branch into a new pi process in a Rex split. Usage: /split-fork [-d right|left|down|up] [optional prompt]",
		getArgumentCompletions,
		handler: async (args, ctx) => {
			if (!isRexSession()) {
				ctx.ui.notify("/split-fork requires Rex.", "warning")

				return
			}

			let parsedArgs: { direction: SplitDirection; prompt: string }

			try {
				parsedArgs = parseSplitForkArgs(args)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				ctx.ui.notify(`${message} Usage: /split-fork [-d right|left|down|up] [optional prompt]`, "error")

				return
			}

			const wasBusy = !ctx.isIdle()
			let clonedSessionFile: string | undefined

			try {
				clonedSessionFile = createClonedSession(ctx)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				ctx.ui.notify(`Failed to clone the active session branch: ${message}`, "error")

				return
			}

			const startupInput = buildPiStartupInput(clonedSessionFile, parsedArgs.prompt)

			const result = await launchTerminalSplit(pi, ctx, startupInput, parsedArgs.direction)

			if (!result.ok) {
				ctx.ui.notify(`Failed to launch ${result.terminalName} split: ${result.reason}`, "error")

				if (clonedSessionFile) {
					ctx.ui.notify(`Cloned session was created: ${clonedSessionFile}`, "info")
				}

				return
			}

			if (clonedSessionFile) {
				const fileName = path.basename(clonedSessionFile)
				const promptSuffix = parsedArgs.prompt ? " and sent prompt" : ""
				ctx.ui.notify(
					`Cloned the active branch to ${fileName} in a new ${result.terminalName} ${parsedArgs.direction} split${promptSuffix}.`,
					"info",
				)

				if (wasBusy) {
					ctx.ui.notify("Cloned from current committed state (in-flight turn continues in original session).", "info")
				}
			} else {
				ctx.ui.notify(`Opened a new ${result.terminalName} split (no persisted branch to clone).`, "warning")
			}
		},
	})
}

// Adapted from https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/split-fork.ts
// Original work licensed under the Apache License 2.0 (Apache-2.0).

import { randomUUID } from "node:crypto"
import { promises as fs, existsSync } from "node:fs"
import * as path from "node:path"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import type { AutocompleteItem } from "@earendil-works/pi-tui"

const VALID_DIRECTIONS = ["right", "left", "down", "up"] as const
const DEFAULT_DIRECTION = "right"
type SplitDirection = (typeof VALID_DIRECTIONS)[number]

const GHOSTTY_SPLIT_SCRIPT = `on run argv
	set targetCwd to item 1 of argv
	set startupInput to item 2 of argv
	set splitDirection to item 3 of argv
	tell application "Ghostty"
		set cfg to new surface configuration
		set initial working directory of cfg to targetCwd
		set initial input of cfg to startupInput
		if (count of windows) > 0 then
			set targetTerminalId to id of focused terminal of selected tab of front window
			-- Ghostty's AppleScript split command accepts literal direction tokens here.
			if splitDirection is "right" then
				split terminal id targetTerminalId direction right with configuration cfg
			else if splitDirection is "left" then
				split terminal id targetTerminalId direction left with configuration cfg
			else if splitDirection is "down" then
				split terminal id targetTerminalId direction down with configuration cfg
			else if splitDirection is "up" then
				split terminal id targetTerminalId direction up with configuration cfg
			else
				error "Invalid split direction: " & splitDirection
			end if
		else
			new window with configuration cfg
		end if
		activate
	end tell
end run`

function shellQuote(value: string): string {
	if (value.length === 0) return "''"
	return `'${value.replace(/'/g, `'"'"'`)}'`
}

function getPiInvocationParts(): string[] {
	const override = process.env.PI_SPLIT_FORK_COMMAND?.trim()
	if (override) {
		return [override]
	}

	const currentScript = process.argv[1]
	if (currentScript && existsSync(currentScript)) {
		return [process.execPath, currentScript]
	}

	const execName = path.basename(process.execPath).toLowerCase()
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
	if (!isGenericRuntime) {
		return [process.execPath]
	}

	return ["pi"]
}

function buildPiStartupInput(sessionFile: string | undefined, prompt: string): string {
	const commandParts = [...getPiInvocationParts()]

	if (sessionFile) {
		commandParts.push("--session", sessionFile)
	}

	if (prompt.length > 0) {
		commandParts.push("--", prompt)
	}

	return `${commandParts.map(shellQuote).join(" ")}\n`
}

function isSplitDirection(value: string): value is SplitDirection {
	return (VALID_DIRECTIONS as readonly string[]).includes(value)
}

function parseSplitForkArgs(raw: string): { direction: SplitDirection; prompt: string } {
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
			throw new Error(`Invalid direction \"${value}\". Expected one of: right, left, down, up.`)
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
			throw new Error(`Invalid direction \"${value}\". Expected one of: right, left, down, up.`)
		}
		return { direction: value, prompt }
	}

	const unknownFlag = trimmed.match(/^(-\S+)/)?.[1]
	throw new Error(`Unknown option: ${unknownFlag ?? trimmed}`)
}

async function createForkedSession(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const sessionFile = ctx.sessionManager.getSessionFile()
	if (!sessionFile) {
		return undefined
	}

	const sessionDir = path.dirname(sessionFile)
	const branchEntries = ctx.sessionManager.getBranch()
	const currentHeader = ctx.sessionManager.getHeader()

	const timestamp = new Date().toISOString()
	const fileTimestamp = timestamp.replace(/[:.]/g, "-")
	const newSessionId = randomUUID()
	const newSessionFile = path.join(sessionDir, `${fileTimestamp}_${newSessionId}.jsonl`)

	const newHeader = {
		type: "session",
		version: currentHeader?.version ?? 3,
		id: newSessionId,
		timestamp,
		cwd: currentHeader?.cwd ?? ctx.cwd,
		parentSession: sessionFile,
	}

	const lines = `${[JSON.stringify(newHeader), ...branchEntries.map((entry) => JSON.stringify(entry))].join("\n")}\n`

	await fs.mkdir(sessionDir, { recursive: true })
	await fs.writeFile(newSessionFile, lines, "utf8")

	return newSessionFile
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
			"Fork this session into a new pi process in a Ghostty split. Usage: /split-fork [-d right|left|down|up] [optional prompt]",
		getArgumentCompletions,
		handler: async (args, ctx) => {
			if (process.platform !== "darwin") {
				ctx.ui.notify("/split-fork currently requires macOS (Ghostty AppleScript).", "warning")
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
			const forkedSessionFile = await createForkedSession(ctx)
			const startupInput = buildPiStartupInput(forkedSessionFile, parsedArgs.prompt)

			const result = await pi.exec("osascript", [
				"-e",
				GHOSTTY_SPLIT_SCRIPT,
				"--",
				ctx.cwd,
				startupInput,
				parsedArgs.direction,
			])
			if (result.code !== 0) {
				const reason = result.stderr?.trim() || result.stdout?.trim() || "unknown osascript error"
				ctx.ui.notify(`Failed to launch Ghostty split: ${reason}`, "error")
				if (forkedSessionFile) {
					ctx.ui.notify(`Forked session was created: ${forkedSessionFile}`, "info")
				}
				return
			}

			if (forkedSessionFile) {
				const fileName = path.basename(forkedSessionFile)
				const promptSuffix = parsedArgs.prompt ? " and sent prompt" : ""
				ctx.ui.notify(`Forked to ${fileName} in a new Ghostty ${parsedArgs.direction} split${promptSuffix}.`, "info")
				if (wasBusy) {
					ctx.ui.notify("Forked from current committed state (in-flight turn continues in original session).", "info")
				}
			} else {
				ctx.ui.notify("Opened a new Ghostty split (no persisted session to fork).", "warning")
			}
		},
	})
}

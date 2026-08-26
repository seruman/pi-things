// Adapted from https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/split-fork.ts
// Original work licensed under the Apache License 2.0 (Apache-2.0).

import { existsSync } from "node:fs"
import * as path from "node:path"
import { type ExtensionAPI, type ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent"
import type { AutocompleteItem } from "@earendil-works/pi-tui"

const VALID_DIRECTIONS = ["right", "left", "down", "up"] as const
const DEFAULT_DIRECTION = "right"
export type SplitDirection = (typeof VALID_DIRECTIONS)[number]
export type SplitLaunchResult = { ok: true; terminalName: string } | { ok: false; terminalName: string; reason: string }

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

export function isTeteyeSession(): boolean {
	return Boolean(process.env.TETEYE_SOCKET?.trim() && process.env.TETEYE_PANE_ID?.trim())
}

function getTeteyeCtlPath(): string {
	return process.env.TETEYECTL_PATH?.trim() || "teteyectl"
}

function getTeteyeResponseError(stdout: string | undefined, stderr: string | undefined): string {
	const trimmedStdout = stdout?.trim()
	if (trimmedStdout) {
		try {
			const response = JSON.parse(trimmedStdout) as { error?: unknown }
			if (typeof response.error === "string" && response.error.length > 0) return response.error
		} catch {
			// Fall back to the raw output below.
		}
	}
	return stderr?.trim() || trimmedStdout || "unknown teteyectl error"
}

function getPaneIdFromTeteyeResponse(stdout: string | undefined): string | undefined {
	if (!stdout?.trim()) return undefined
	const response = JSON.parse(stdout) as { result?: { pane_id?: unknown } }
	return typeof response.result?.pane_id === "string" ? response.result.pane_id : undefined
}

export function resolvePiInvocation(
	execPath: string,
	currentScript: string | undefined,
	currentScriptExists: boolean,
): string[] {
	const execName = path.basename(execPath).toLowerCase()
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
	if (!isGenericRuntime) return [execPath]
	if (currentScript && currentScriptExists) return [execPath, currentScript]
	return ["pi"]
}

function getPiInvocationParts(): string[] {
	const override = process.env.PI_SPLIT_FORK_COMMAND?.trim()
	if (override) return [override]

	const currentScript = process.argv[1]
	return resolvePiInvocation(process.execPath, currentScript, Boolean(currentScript && existsSync(currentScript)))
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
	return (VALID_DIRECTIONS as readonly string[]).includes(value)
}

export function parseSplitForkArgs(raw: string): { direction: SplitDirection; prompt: string } {
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

async function launchGhosttySplit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	startupInput: string,
	direction: SplitDirection,
): Promise<SplitLaunchResult> {
	const result = await pi.exec("osascript", ["-e", GHOSTTY_SPLIT_SCRIPT, "--", ctx.cwd, startupInput, direction])
	if (result.code !== 0) {
		return {
			ok: false,
			terminalName: "Ghostty",
			reason: result.stderr?.trim() || result.stdout?.trim() || "unknown osascript error",
		}
	}
	return { ok: true, terminalName: "Ghostty" }
}

async function launchTeteyeSplit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	startupInput: string,
	direction: SplitDirection,
): Promise<SplitLaunchResult> {
	const socket = process.env.TETEYE_SOCKET?.trim()
	if (!socket || !process.env.TETEYE_PANE_ID?.trim()) {
		return { ok: false, terminalName: "teteye", reason: "missing TETEYE_SOCKET or TETEYE_PANE_ID" }
	}

	const teteyectl = getTeteyeCtlPath()
	const splitResult = await pi.exec(teteyectl, ["split", direction, "--socket", socket, "--json"])
	if (splitResult.code !== 0) {
		return { ok: false, terminalName: "teteye", reason: getTeteyeResponseError(splitResult.stdout, splitResult.stderr) }
	}

	let newPaneId: string
	try {
		newPaneId = getPaneIdFromTeteyeResponse(splitResult.stdout) ?? ""
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		return { ok: false, terminalName: "teteye", reason: `invalid split response: ${reason}` }
	}
	if (!newPaneId) {
		return { ok: false, terminalName: "teteye", reason: "split response did not include a pane_id" }
	}

	const sendResult = await pi.exec(teteyectl, [
		"send-text",
		`cd ${shellQuote(ctx.cwd)} && ${startupInput}`,
		"--socket",
		socket,
		"--pane",
		newPaneId,
		"--json",
	])
	if (sendResult.code !== 0) {
		return { ok: false, terminalName: "teteye", reason: getTeteyeResponseError(sendResult.stdout, sendResult.stderr) }
	}

	return { ok: true, terminalName: "teteye" }
}

export async function launchTerminalSplit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	startupInput: string,
	direction: SplitDirection,
): Promise<SplitLaunchResult> {
	return isTeteyeSession()
		? launchTeteyeSplit(pi, ctx, startupInput, direction)
		: launchGhosttySplit(pi, ctx, startupInput, direction)
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
			"Clone the active session branch into a new pi process in a teteye or Ghostty split. Usage: /split-fork [-d right|left|down|up] [optional prompt]",
		getArgumentCompletions,
		handler: async (args, ctx) => {
			if (process.platform !== "darwin" && !isTeteyeSession()) {
				ctx.ui.notify("/split-fork currently requires teteye or macOS (Ghostty AppleScript).", "warning")
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

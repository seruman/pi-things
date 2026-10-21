import { fileURLToPath } from "node:url"
import type { RexClient, TerminalBlock } from "../rex/client"
import { getPiInvocationParts } from "../split-fork"
import type { SpawnParameters } from "./schemas"

export interface Launch {
	peerId: string
	label?: string
	namespace?: string
	model?: string
	thinkingLevel?: string
}

export const labelEnv = "PI_PEERS_LABEL"

export const namespaceEnv = "PI_PEERS_NAMESPACE"

export function launchCommand(launch: Launch): string[] {
	const env: string[] = []

	if (launch.label !== undefined) env.push(`${labelEnv}=${launch.label}`)

	if (launch.namespace !== undefined) env.push(`${namespaceEnv}=${launch.namespace}`)

	return [
		...(env.length > 0 ? ["env", ...env] : []),
		// Resolves piw and other rebrands the same way subagents and split-fork do.
		...getPiInvocationParts(),
		// Load peers even when the installed package is older or cwd differs.
		"--extension",
		fileURLToPath(new URL("./index.ts", import.meta.url)),
		"--session-id",
		launch.peerId,
		...(launch.model ? ["--model", launch.model] : []),
		...(launch.thinkingLevel ? ["--thinking", launch.thinkingLevel] : []),
	]
}

export async function place(
	rex: RexClient,
	rexSession: string,
	placement: SpawnParameters["placement"],
	block: TerminalBlock,
	signal?: AbortSignal,
): Promise<{ blockId: string; windowId?: string }> {
	const window = placement?.window

	if (window !== undefined && placement?.splitBeside !== undefined) {
		throw new Error("placement.window and placement.splitBeside cannot be combined")
	}

	// New peers never take focus away from the user.
	if (placement?.splitBeside !== undefined) {
		return rex.newSplit(rexSession, block, { anchorBlockId: placement.splitBeside, focus: false }, signal)
	}

	if (window !== undefined && window !== "new") {
		return rex.newSplit(rexSession, block, { windowId: window, focus: false }, signal)
	}

	return rex.newWindow(rexSession, block, { focus: false }, signal)
}

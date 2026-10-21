import type { RexMethods } from "./rex-api"

interface ExecResult {
	stdout: string
	stderr: string
	code: number
}

export type Exec = (command: string, args: string[], signal?: AbortSignal) => Promise<ExecResult>

export type RexMethod = keyof RexMethods

// The CLI fills session_id from `-s`, so callers never repeat it.
export type RexInput<Method extends RexMethod> = Omit<RexMethods[Method]["input"], "session_id">

export type RexOutput<Method extends RexMethod> = RexMethods[Method]["output"]

export type RexBlock = NonNullable<RexOutput<"session.list_blocks">["blocks"]>[number]

export const terminalFlavor = "com.superlogical.terminal.shell"

/** A terminal block. Rex runs `command` through the user's default login shell. */
export interface TerminalBlock {
	label?: string
	cwd: string
	command: string[]
}

export interface SplitPlacement {
	/** Split beside this block. Without it, Rex splits the given window. */
	anchorBlockId?: string
	windowId?: string
	direction?: "horizontal" | "vertical"
	side?: "before" | "after"
	focus?: boolean
}

export interface RexClient {
	call<Method extends RexMethod>(
		sessionId: string,
		method: Method,
		args: RexInput<Method>,
		signal?: AbortSignal,
	): Promise<RexOutput<Method>>
	newWindow(
		sessionId: string,
		block: TerminalBlock,
		options?: { focus?: boolean; windowLabel?: string },
		signal?: AbortSignal,
	): Promise<{ windowId: string; blockId: string }>
	newSplit(
		sessionId: string,
		block: TerminalBlock,
		placement: SplitPlacement,
		signal?: AbortSignal,
	): Promise<{ blockId: string }>
	listBlocks(sessionId: string, signal?: AbortSignal): Promise<RexBlock[]>
	describeBlock(sessionId: string, blockId: string, signal?: AbortSignal): Promise<RexBlock>
	closeBlock(sessionId: string, blockId: string, signal?: AbortSignal): Promise<void>
}

// A type alias, not an interface, so it fits Rex's open JSON layout input.
type TerminalLayout = {
	block: {
		flavor: typeof terminalFlavor
		label?: string
		options: { cwd: string; command: string[] }
	}
}

// Rex's input schema leaves layouts open; this is the subset peers creates.
function layout(block: TerminalBlock): TerminalLayout {
	// Only cwd and command: Rex picks the user's default shell and login environment.
	const node: TerminalLayout = {
		block: { flavor: terminalFlavor, options: { cwd: block.cwd, command: block.command } },
	}

	if (block.label !== undefined) node.block.label = block.label

	return node
}

function firstBlock(method: string, blockIds: (string | null)[] | null): string {
	const blockId = blockIds?.[0]

	if (!blockId) throw new Error(`${method} did not return a block id`)

	return blockId
}

export function createRexClient(exec: Exec, command = "rex"): RexClient {
	const call: RexClient["call"] = async (sessionId, method, args, signal) => {
		if (!sessionId) throw new Error(`${method}: a Rex session id is required`)
		const result = await exec(command, ["api", "call", "-s", sessionId, method, JSON.stringify(args)], signal)

		if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${method} failed`)

		try {
			return JSON.parse(result.stdout)
		} catch (error) {
			throw new Error(`${method} returned invalid JSON: ${result.stdout.trim()}`, { cause: error })
		}
	}

	return {
		call,
		async newWindow(sessionId, block, options = {}, signal) {
			const args: RexInput<"session.new_window"> = { layout: layout(block), focus: options.focus ?? false }

			if (options.windowLabel !== undefined) args.window_label = options.windowLabel
			const created = await call(sessionId, "session.new_window", args, signal)

			if (!created.window_id) throw new Error("session.new_window did not return a window id")

			return { windowId: created.window_id, blockId: firstBlock("session.new_window", created.block_ids) }
		},
		async newSplit(sessionId, block, placement, signal) {
			const created = await call(
				sessionId,
				"session.new_split",
				{
					anchor_block_id: placement.anchorBlockId ?? null,
					window_id: placement.windowId ?? null,
					direction: placement.direction ?? "horizontal",
					side: placement.side ?? "after",
					layout: layout(block),
					focus: placement.focus ?? false,
				},
				signal,
			)

			return { blockId: firstBlock("session.new_split", created.block_ids) }
		},
		async listBlocks(sessionId, signal) {
			return (await call(sessionId, "session.list_blocks", {}, signal)).blocks ?? []
		},
		async describeBlock(sessionId, blockId, signal) {
			return (await call(sessionId, "session.describe_block", { block_id: blockId }, signal)).block
		},
		async closeBlock(sessionId, blockId, signal) {
			await call(sessionId, "block.close", { block_id: blockId }, signal)
		},
	}
}

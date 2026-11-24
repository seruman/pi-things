import { z } from "zod"
import { type RexExec, resolveRexSession } from "../lib/rex"
import type { RunMetadata } from "./runs"

export type Exec = RexExec

// Wire contracts from `rex api describe` (including the terminal creator's process method).
const revisionSchema = z.number().int().nonnegative()

const newLayerSchema = z.object({
	layer_id: z.string(),
	block_ids: z.array(z.string()).length(1),
	revision: revisionSchema,
})

const viewSchema = z.object({
	windows: z
		.array(
			z.object({
				window_id: z.string(),
				layers: z
					.array(
						z.object({
							layer_id: z.string(),
							kind: z.string(),
							blocks: z.array(z.object({ block_id: z.string() })).nullable(),
						}),
					)
					.nullable(),
			}),
		)
		.nullable()
		.optional(),
})

const closedBlockSchema = z.object({ block_id: z.string(), revision: revisionSchema })

const focusedBlockSchema = z.object({ revision: revisionSchema })

const processInfoSchema = z.object({
	pid: z.number().int(),
	user_id: z.number().int(),
	name: z.string(),
	argv0: z.string().optional(),
	cwd: z.string().optional(),
	invoked_path: z.string().optional(),
	path: z.string().optional(),
	script: z.string().optional(),
	user: z.string().optional(),
})

const processSchema = z.object({
	last_exit: z.object({ exit_code: z.number().int(), error: z.string().optional() }).nullable(),
	child: processInfoSchema.nullable().optional(),
	foreground: processInfoSchema.nullable().optional(),
	ancestors: z.array(processInfoSchema).nullable().optional(),
	home: z.string().optional(),
})

interface NewBlockArgs {
	flavor: "com.superlogical.terminal.shell"
	label: string
	options: { cwd: string; command: string[] }
}

interface BlockArgs {
	block_id: string
}

type RexRequest =
	| { method: "session.view"; args: Record<string, never> }
	| {
			method: "session.new_layer"
			args: {
				window_id: string
				bounds: [number, number, number, number]
				focus: false
				layout: { block: NewBlockArgs }
			}
	  }
	| { method: "block.close" | "session.focus_block"; args: BlockArgs }
	| { method: "session.set_block_label"; args: BlockArgs & { label: string } }
	| {
			method: "session.set_layer_state"
			args: {
				layer_id: string
				state: "normal" | "minimized"
				focus?: boolean
			}
	  }

export const runStates = ["starting", "busy", "idle", "exited", "error", "suspended", "stopped", "unknown"] as const

export type RunState = (typeof runStates)[number]

export type ProcessReader = (blockId: string, signal?: AbortSignal) => ReturnType<typeof readProcess>

// The bridge owns lifecycle state. Rex only tells us whether its process still exists.
export async function effectiveRunState(
	exec: Exec,
	run: Pick<RunMetadata, "blockId" | "suspended" | "stoppedAt" | "state">,
	signal?: AbortSignal,
	inspect: ProcessReader = (blockId, signal) => readProcess(exec, blockId, signal),
): Promise<RunState> {
	if (run.stoppedAt) return "stopped"

	if (run.state === "error") return "error"

	if (run.suspended) return "suspended"

	if (run.state === "exited") return "exited"
	const { alive } = await inspect(run.blockId, signal)

	return alive ? (run.state ?? "starting") : "exited"
}

async function api<Result>(
	exec: Exec,
	request: RexRequest,
	responseSchema: z.ZodType<Result>,
	signal?: AbortSignal,
): Promise<Result> {
	const block = process.env.REX_BLOCK?.trim()

	if (!block) throw new Error("REX_BLOCK is required")
	const session = await resolveRexSession(exec, block, signal)

	const result = await exec(
		"rex",
		["api", "call", "-s", session, request.method, JSON.stringify({ session_id: session, ...request.args })],
		signal,
	)

	if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${request.method} failed`)

	return responseSchema.parse(JSON.parse(result.stdout))
}

export async function newBlock(
	exec: Exec,
	cwd: string,
	name: string,
	command: string[],
	signal?: AbortSignal,
): Promise<string> {
	const parentBlock = process.env.REX_BLOCK

	if (!parentBlock) throw new Error("REX_BLOCK is required to place subagents in Pi's window")
	const { window } = await placement(exec, parentBlock, signal)

	const created = await api(
		exec,
		{
			method: "session.new_layer",
			args: {
				window_id: window.window_id,
				bounds: [0.1, 0.1, 0.8, 0.8],
				focus: false,
				layout: {
					block: {
						flavor: "com.superlogical.terminal.shell",
						label: `subagent ${name}`,
						options: { cwd, command },
					},
				},
			},
		},
		newLayerSchema,
		signal,
	)

	const blockId = created.block_ids[0]!

	try {
		await api(
			exec,
			{
				method: "session.set_layer_state",
				args: { layer_id: created.layer_id, state: "minimized" },
			},
			focusedBlockSchema,
			signal,
		)
	} catch (error) {
		// Creation succeeded: don't orphan a running child if minimizing fails or is cancelled.
		try {
			await closeBlock(exec, blockId)
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], `Could not minimize or close subagent block ${blockId}`)
		}

		throw error
	}

	return blockId
}

async function placement(exec: Exec, blockId: string, signal?: AbortSignal) {
	const view = await api(exec, { method: "session.view", args: {} }, viewSchema, signal)

	for (const window of view.windows ?? []) {
		for (const layer of window.layers ?? []) {
			if (layer.blocks?.some((block) => block.block_id === blockId)) return { window, layer }
		}
	}

	throw new Error(`Rex block ${blockId} is not placed in a window`)
}

export async function showBlock(exec: Exec, blockId: string): Promise<void> {
	// Resolve the current layer: the user may have moved or docked the terminal.
	const { layer } = await placement(exec, blockId)

	if (layer.kind === "floating") {
		await api(
			exec,
			{
				method: "session.set_layer_state",
				args: { layer_id: layer.layer_id, state: "normal", focus: true },
			},
			focusedBlockSchema,
		)
	}

	await api(exec, { method: "session.focus_block", args: { block_id: blockId } }, focusedBlockSchema)
}

export async function setBlockName(exec: Exec, blockId: string, name: string, signal?: AbortSignal): Promise<void> {
	await api(
		exec,
		{ method: "session.set_block_label", args: { block_id: blockId, label: `subagent ${name}` } },
		focusedBlockSchema,
		signal,
	)
}

export async function closeBlock(exec: Exec, blockId: string, signal?: AbortSignal): Promise<void> {
	await api(exec, { method: "block.close", args: { block_id: blockId } }, closedBlockSchema, signal)
}

export async function readProcess(
	exec: Exec,
	blockId: string,
	signal?: AbortSignal,
): Promise<{ exists: boolean; alive: boolean }> {
	const result = await exec("rex", ["block", "call", "-b", blockId, "process"], signal)

	if (result.code !== 0) {
		const message = result.stderr.trim() || result.stdout.trim()

		if (message === `Error: block target "${blockId}" not found`) return { exists: false, alive: false }
		throw new Error(message || "process inspection failed")
	}

	const info = processSchema.parse(JSON.parse(result.stdout))

	return { exists: true, alive: info.last_exit === null }
}

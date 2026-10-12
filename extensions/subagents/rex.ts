import { z } from "zod"
import type { RunMetadata } from "./runs"

interface ExecResult {
	stdout: string
	stderr: string
	code: number
}

export type Exec = (command: string, args: string[], signal?: AbortSignal) => Promise<ExecResult>

// Wire contracts from `rex api describe` (including the terminal creator's process method).
const revisionSchema = z.number().int().nonnegative()

const newBlockSchema = z.object({ block_id: z.string().nullable(), revision: revisionSchema })

const closedBlockSchema = z.object({ block_id: z.string(), revision: revisionSchema })

const movedBlockSchema = z.object({
	created_split_id: z.string().nullable(),
	removed_split_id: z.string().nullable().optional(),
	revision: revisionSchema,
})

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

interface MoveBlockArgs extends BlockArgs {
	anchor_block_id: string | null
}

type RexRequest =
	| { method: "session.new_block"; args: NewBlockArgs }
	| { method: "block.close" | "session.focus_block"; args: BlockArgs }
	| { method: "session.move_block"; args: MoveBlockArgs }

export const runStates = ["starting", "busy", "idle", "exited", "error", "suspended", "unknown"] as const

export type RunState = (typeof runStates)[number]

// The bridge owns lifecycle state. Rex only tells us whether its process still exists.
export async function effectiveRunState(
	exec: Exec,
	run: Pick<RunMetadata, "blockId" | "suspended" | "state">,
	signal?: AbortSignal,
): Promise<RunState> {
	if (run.state === "error") return "error"

	if (run.suspended) return "suspended"

	if (run.state === "exited") return "exited"
	const { alive } = await readProcess(exec, run.blockId, signal)

	return alive ? (run.state ?? "starting") : "exited"
}

async function api<Result>(
	exec: Exec,
	request: RexRequest,
	responseSchema: z.ZodType<Result>,
	signal?: AbortSignal,
): Promise<Result> {
	const session = process.env.REX_SESSION

	if (!session) throw new Error("REX_SESSION is required")

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
	handle: string,
	command: string[],
	signal?: AbortSignal,
): Promise<string> {
	const created = await api(
		exec,
		{
			method: "session.new_block",
			args: { flavor: "com.superlogical.terminal.shell", label: `subagent ${handle}`, options: { cwd, command } },
		},
		newBlockSchema,
		signal,
	)

	if (created.block_id === null) throw new Error("Rex did not create a subagent block")

	return created.block_id
}

export async function showBlock(exec: Exec, blockId: string): Promise<void> {
	await api(
		exec,
		{
			method: "session.move_block",
			args: { block_id: blockId, anchor_block_id: process.env.REX_BLOCK ?? null },
		},
		movedBlockSchema,
	)
	await api(exec, { method: "session.focus_block", args: { block_id: blockId } }, focusedBlockSchema)
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

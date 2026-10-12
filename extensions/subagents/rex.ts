import { z } from "zod"
import type { RunMetadata } from "./runs"

interface ExecResult {
	stdout: string
	stderr: string
	code: number
}

export type Exec = (command: string, args: string[], signal?: AbortSignal) => Promise<ExecResult>

const newBlockSchema = z.object({ block_id: z.string() })

const processSchema = z.object({ last_exit: z.object({ exit_code: z.number() }).nullable() })

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

type RexArguments =
	| { flavor: string; label: string; options: { cwd: string; command: string[] } }
	| { block_id: string; anchor_block_id?: string }

async function api(exec: Exec, method: string, args: RexArguments, signal?: AbortSignal): Promise<string> {
	const session = process.env.REX_SESSION

	if (!session) throw new Error("REX_SESSION is required")

	const result = await exec(
		"rex",
		["api", "call", "-s", session, method, JSON.stringify({ session_id: session, ...args })],
		signal,
	)

	if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${method} failed`)

	return result.stdout
}

export async function newBlock(
	exec: Exec,
	cwd: string,
	handle: string,
	command: string[],
	signal?: AbortSignal,
): Promise<string> {
	const response = await api(
		exec,
		"session.new_block",
		{
			flavor: "com.superlogical.terminal.shell",
			label: `subagent ${handle}`,
			options: { cwd, command },
		},
		signal,
	)

	const created = newBlockSchema.parse(JSON.parse(response))

	return created.block_id
}

export async function showBlock(exec: Exec, blockId: string): Promise<void> {
	await api(exec, "session.move_block", { block_id: blockId, anchor_block_id: process.env.REX_BLOCK })
	await api(exec, "session.focus_block", { block_id: blockId })
}

export async function closeBlock(exec: Exec, blockId: string, signal?: AbortSignal): Promise<void> {
	await api(exec, "block.close", { block_id: blockId }, signal)
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

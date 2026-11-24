import { z } from "zod"

export type RexExec = (
	command: string,
	args: string[],
	signal?: AbortSignal,
) => Promise<{ stdout: string; stderr: string; code: number }>

/** Resolve an actual session ID from a specific pane, never from the focused session or stale environment. */
export async function resolveRexSession(exec: RexExec, block: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted()

	if (!/^block:\S+$/.test(block)) throw new Error("REX_BLOCK must be a full Rex block ID")

	const result = await exec("rex", ["block", "inspect", block, "--json"], signal)
	signal?.throwIfAborted()

	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `Could not inspect Rex block ${block}`)
	}

	const location = z
		.object({ session_id: z.string().regex(/^session:\S+$/), block: z.object({ block_id: z.literal(block) }) })
		.parse(JSON.parse(result.stdout))

	return location.session_id
}

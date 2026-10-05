import type { Usage } from "@earendil-works/pi-ai"
import type { AgentSession } from "@earendil-works/pi-coding-agent"

export function childUsage(session?: AgentSession): Usage {
	const stats = session?.getSessionStats()
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: stats?.cost ?? 0 }
	const usage: Usage = {
		input: stats?.tokens.input ?? 0,
		output: stats?.tokens.output ?? 0,
		cacheRead: stats?.tokens.cacheRead ?? 0,
		cacheWrite: stats?.tokens.cacheWrite ?? 0,
		totalTokens: stats?.tokens.total ?? 0,
		cost,
	}
	for (const entry of session?.sessionManager.getEntries() ?? []) {
		const part =
			entry.type === "message"
				? entry.message.role === "assistant" || entry.message.role === "toolResult"
					? entry.message.usage
					: undefined
				: entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary"
					? entry.usage
					: undefined
		if (!part) continue
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) cost[key] += part.cost[key]
		if (part.reasoning !== undefined) usage.reasoning = (usage.reasoning ?? 0) + part.reasoning
		if (part.cacheWrite1h !== undefined) usage.cacheWrite1h = (usage.cacheWrite1h ?? 0) + part.cacheWrite1h
	}
	return usage
}

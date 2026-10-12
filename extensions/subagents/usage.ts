import type { Usage } from "@earendil-works/pi-ai"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"

function partOf(entry: SessionEntry): Usage | undefined {
	if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
		return entry.message.usage
	}
	if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") return entry.usage
	return undefined
}

export function childUsage(entries: SessionEntry[]): Usage {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	}
	for (const entry of entries) {
		const part = partOf(entry)
		if (!part) continue
		usage.input += part.input
		usage.output += part.output
		usage.cacheRead += part.cacheRead
		usage.cacheWrite += part.cacheWrite
		usage.totalTokens += part.totalTokens
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
			usage.cost[key] += part.cost[key]
		if (part.reasoning !== undefined) usage.reasoning = (usage.reasoning ?? 0) + part.reasoning
		if (part.cacheWrite1h !== undefined) usage.cacheWrite1h = (usage.cacheWrite1h ?? 0) + part.cacheWrite1h
	}
	return usage
}

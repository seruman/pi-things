import type { Message } from "@earendil-works/pi-ai"

export const HISTORY_LIMIT = 4000
export const HISTORY_MESSAGE_LIMIT = 1200
export const HISTORY_MESSAGES = 6
const OMITTED = "\n[truncated]\n"

/** Preserve both the opening context and the conclusion of long messages. */
function excerpt(text: string, limit: number): string {
	if (text.length <= limit) return text
	const available = limit - OMITTED.length
	return text.slice(0, Math.ceil(available / 2)) + OMITTED + text.slice(-Math.floor(available / 2))
}

/** Projected branch history only: no system prompt, thinking, images, or tool arguments. */
export function recentConversation(messages: readonly Message[]): string {
	let currentUser = messages.length - 1
	while (currentUser >= 0 && messages[currentUser].role !== "user") currentUser--
	const parts: string[] = []
	let used = 0
	// The current user request is sent separately. Ignore any later injected messages too.
	for (let i = currentUser - 1; i >= 0 && parts.length < HISTORY_MESSAGES; i--) {
		const message = messages[i]
		if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") continue
		const text = (
			typeof message.content === "string"
				? message.content
				: message.content
						.flatMap((block) => {
							if (block.type === "text") return [block.text]
							if (block.type === "toolCall") return [`[tool call: ${block.name}]`]
							if (block.type === "image") return ["[image omitted]"]
							return []
						})
						.join("\n")
		).trim()
		if (!text) continue
		const label =
			message.role === "toolResult"
				? `toolResult (${message.toolName.slice(0, 80)}${message.isError ? ", error" : ""})`
				: message.role
		const header = `${label}:\n`
		const separator = parts.length ? 2 : 0
		const budget = Math.min(HISTORY_MESSAGE_LIMIT, HISTORY_LIMIT - used - header.length - separator)
		if (budget <= OMITTED.length) break
		const part = header + excerpt(text, budget)
		parts.unshift(part)
		used += part.length + separator
	}
	return parts.join("\n\n")
}

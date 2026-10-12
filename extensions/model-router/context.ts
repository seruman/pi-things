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
	const dialogue: { index: number; label: string; text: string }[] = []
	const tools: typeof dialogue = []
	let haveAssistantReply = false
	// Keep user turns and the latest assistant prose per turn before tool outputs.
	// Neither command output nor repeated progress updates should crowd out corrections.
	// The current request is sent separately; ignore later injected messages too.
	for (let i = currentUser - 1; i >= 0 && dialogue.length < HISTORY_MESSAGES; i--) {
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
		const hasProse =
			typeof message.content === "string" || message.content.some((block) => block.type === "text" && block.text.trim())
		if (message.role === "user") haveAssistantReply = false
		if (message.role === "assistant" && hasProse) {
			if (haveAssistantReply) continue
			haveAssistantReply = true
		}
		const candidates = message.role === "user" || (message.role === "assistant" && hasProse) ? dialogue : tools
		if (candidates.length < HISTORY_MESSAGES) candidates.push({ index: i, label, text })
	}
	const parts: { index: number; text: string }[] = []
	let used = 0
	for (const candidate of [...dialogue, ...tools]) {
		if (parts.length === HISTORY_MESSAGES) break
		const header = `${candidate.label}:\n`
		const separator = parts.length ? 2 : 0
		const budget = Math.min(HISTORY_MESSAGE_LIMIT, HISTORY_LIMIT - used - header.length - separator)
		if (budget <= OMITTED.length) break
		const text = header + excerpt(candidate.text, budget)
		parts.push({ index: candidate.index, text })
		used += text.length + separator
	}
	return parts
		.sort((a, b) => a.index - b.index)
		.map((part) => part.text)
		.join("\n\n")
}

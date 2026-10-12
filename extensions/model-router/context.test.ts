import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message } from "@earendil-works/pi-ai"
import { HISTORY_LIMIT, HISTORY_MESSAGES, HISTORY_MESSAGE_LIMIT, recentConversation } from "./context"

const user = (content: string): Message => ({ role: "user", content, timestamp: 0 })
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	api: "openai-responses",
	provider: "test",
	model: "test",
	stopReason: "stop",
	timestamp: 0,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
})

describe("classifier conversation context", () => {
	test("excludes the current request, system prompts, and later injected messages", () => {
		const messages: Message[] = [
			{ role: "system", content: "private system prompt", timestamp: 0 },
			user("Design a migration"),
			assistant([{ type: "text", text: "I propose two migration steps." }]),
			user("ok, implement that"),
			assistant([{ type: "text", text: "injected after current user" }]),
		]
		const original = structuredClone(messages)
		expect(recentConversation(messages)).toBe("user:\nDesign a migration\n\nassistant:\nI propose two migration steps.")
		expect(messages).toEqual(original)
	})

	test("empty, first-turn, and no-user contexts have no history", () => {
		expect(recentConversation([])).toBe("")
		expect(recentConversation([user("hello")])).toBe("")
		expect(recentConversation([assistant([{ type: "text", text: "no user yet" }])])).toBe("")
	})

	test("repeated prompts are excluded by position rather than text matching", () => {
		expect(recentConversation([user("hello"), user("hello")])).toBe("user:\nhello")
	})

	test("keeps tool result text and names but omits thinking, tool arguments, and image data", () => {
		const history = recentConversation([
			{ role: "user", timestamp: 0, content: [{ type: "image", mimeType: "image/png", data: "private image" }] },
			assistant([
				{ type: "thinking", thinking: "private reasoning", thinkingSignature: "private signature" },
				{ type: "toolCall", id: "call", name: "read", arguments: { path: "private argument" } },
			]),
			{
				role: "toolResult",
				toolCallId: "call",
				toolName: "read",
				isError: true,
				timestamp: 0,
				content: [
					{ type: "text", text: "File missing" },
					{ type: "image", mimeType: "image/png", data: "private result image" },
				],
			},
			user("try another file"),
		])
		expect(history).toBe(
			"user:\n[image omitted]\n\nassistant:\n[tool call: read]\n\ntoolResult (read, error):\nFile missing\n[image omitted]",
		)
		expect(history).not.toContain("private")
	})

	test("empty and thinking-only messages do not displace useful history", () => {
		const history = recentConversation([
			user("original task"),
			...Array.from({ length: 10 }, () => assistant([{ type: "thinking" as const, thinking: "hidden" }])),
			user("  "),
			user("continue"),
		])
		expect(history).toBe("user:\noriginal task")
	})

	test("uses at most six messages, newest first for selection but chronological in the payload", () => {
		const history = recentConversation([...Array.from({ length: 9 }, (_, i) => user(`message ${i}`)), user("latest")])
		expect(history).toBe(Array.from({ length: HISTORY_MESSAGES }, (_, i) => `user:\nmessage ${i + 3}`).join("\n\n"))
	})

	test("tool loops do not crowd out the user's corrections or the assistant's disputed explanation", () => {
		const toolLoop: Message[] = Array.from({ length: 10 }, (_, i) => [
			assistant([
				{ type: "text", text: `Checking output ${i}` },
				{ type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: "private" } },
			]),
			{
				role: "toolResult" as const,
				toolCallId: `call-${i}`,
				toolName: "read",
				isError: false,
				timestamp: 0,
				content: [{ type: "text" as const, text: `output-${i}` }],
			},
		]).flat()
		const history = recentConversation([
			user("Review the mesh simplification algorithm"),
			assistant([{ type: "text", text: "The surface stays smooth; I have not checked the boundary vertices." }]),
			user("The rendered seam disproves that. Inspect the boundary constraints."),
			...toolLoop,
			user("Summarize why the seam appears"),
		])
		expect(history).toContain("Review the mesh simplification algorithm")
		expect(history).toContain("I have not checked the boundary vertices.")
		expect(history).toContain("The rendered seam disproves that.")
		expect(history).toContain("output-9")
		expect(history).toContain("Checking output 9")
		expect(history).not.toContain("Checking output 0")
		expect(history).not.toContain("output-0")
		expect(history).not.toContain("Summarize why the seam appears")
		expect(history).not.toContain("private")
		expect(history.length).toBeLessThanOrEqual(HISTORY_LIMIT)
		expect(history.indexOf("The rendered seam")).toBeLessThan(history.indexOf("output-9"))
	})

	test("bounds each message, preserving its beginning and final proposal", () => {
		const history = recentConversation([
			assistant([{ type: "text", text: `Beginning ${"x".repeat(5000)} Final proposal` }]),
			user("implement it"),
		])
		expect(history.length).toBe("assistant:\n".length + HISTORY_MESSAGE_LIMIT)
		expect(history).toStartWith("assistant:\nBeginning ")
		expect(history).toContain("[truncated]")
		expect(history).toEndWith(" Final proposal")
	})

	test("caps the entire transcript including labels and separators, preferring recent messages", () => {
		const history = recentConversation([
			...Array.from({ length: 10 }, (_, i) => user(`start-${i} ${"x".repeat(5000)} end-${i}`)),
			user("latest"),
		])
		expect(history.length).toBe(HISTORY_LIMIT)
		expect(history).not.toContain("start-5")
		expect(history).toStartWith("user:\nstart-6 ")
		expect(history).toEndWith(" end-9")
	})
})

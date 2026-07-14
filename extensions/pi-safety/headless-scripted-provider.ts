import * as fs from "node:fs"
import * as path from "node:path"
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

type ScriptedResponse =
	| { readonly kind: "text"; readonly text: string }
	| {
			readonly kind: "tool"
			readonly id: string
			readonly name: string
			readonly arguments: Record<string, unknown>
	  }

function parseScript(input: unknown): readonly ScriptedResponse[] {
	if (!Array.isArray(input) || input.length === 0) throw new Error("script must be a non-empty array")
	return input.map((item, index) => {
		if (typeof item !== "object" || item === null || !("kind" in item)) {
			throw new Error(`script response ${index} must be an object with a kind`)
		}
		if (item.kind === "text" && "text" in item && typeof item.text === "string") {
			return { kind: "text", text: item.text }
		}
		if (
			item.kind === "tool" &&
			"id" in item &&
			typeof item.id === "string" &&
			"name" in item &&
			typeof item.name === "string" &&
			"arguments" in item &&
			typeof item.arguments === "object" &&
			item.arguments !== null &&
			!Array.isArray(item.arguments)
		) {
			return { kind: "tool", id: item.id, name: item.name, arguments: { ...item.arguments } }
		}
		throw new Error(`script response ${index} has an invalid shape`)
	})
}

function emptyAssistantMessage(model: Model<string>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	}
}

function streamResponse(model: Model<string>, response: ScriptedResponse): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream()
	const output = emptyAssistantMessage(model)
	stream.push({ type: "start", partial: output })
	if (response.kind === "text") {
		const block = { type: "text" as const, text: response.text }
		output.content.push(block)
		stream.push({ type: "text_start", contentIndex: 0, partial: output })
		stream.push({ type: "text_delta", contentIndex: 0, delta: response.text, partial: output })
		stream.push({ type: "text_end", contentIndex: 0, content: response.text, partial: output })
		stream.push({ type: "done", reason: "stop", message: output })
	} else {
		const toolCall = {
			type: "toolCall" as const,
			id: response.id,
			name: response.name,
			arguments: response.arguments,
		}
		output.content.push(toolCall)
		output.stopReason = "toolUse"
		stream.push({ type: "toolcall_start", contentIndex: 0, partial: output })
		stream.push({
			type: "toolcall_delta",
			contentIndex: 0,
			delta: JSON.stringify(response.arguments),
			partial: output,
		})
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output })
		stream.push({ type: "done", reason: "toolUse", message: output })
	}
	stream.end()
	return stream
}

export default function scriptedProvider(pi: ExtensionAPI): void {
	const scriptPath = process.env.PI_SAFETY_TEST_SCRIPT
	if (!scriptPath || !path.isAbsolute(scriptPath)) {
		throw new Error("PI_SAFETY_TEST_SCRIPT must be an absolute path")
	}
	const script = parseScript(JSON.parse(fs.readFileSync(scriptPath, "utf8")))
	let responseIndex = 0

	pi.registerProvider("pi-safety-scripted", {
		name: "Pi Safety Scripted Test Provider",
		baseUrl: "http://127.0.0.1.invalid",
		apiKey: "test-only",
		api: "pi-safety-scripted",
		models: [
			{
				id: "deterministic",
				name: "Deterministic",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 1024,
			},
		],
		streamSimple: (model: Model<string>, _context: unknown, _options?: SimpleStreamOptions) => {
			const response = script[responseIndex]
			if (!response) throw new Error(`script exhausted after ${responseIndex} responses`)
			responseIndex += 1
			return streamResponse(model, response)
		},
	})
}

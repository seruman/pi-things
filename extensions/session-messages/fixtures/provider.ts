import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

export function gate() {
	let open = () => {}

	const promise = new Promise<void>((resolve) => {
		open = resolve
	})

	return { promise, open }
}

export type Step = { wait?: Promise<void>; tool?: boolean; error?: boolean; text?: string; code?: string }

export function controlledProvider(pi: ExtensionAPI, steps: Step[], requests: TranscriptContext[]) {
	pi.registerProvider("session-message-test", {
		api: "openai-completions",
		apiKey: "test",
		baseUrl: "http://unused.invalid",
		models: [
			{
				id: "controlled",
				name: "Controlled",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 1024,
			},
		],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream()
			requests.push(structuredClone(context))
			const step = steps.shift()

			const message: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: [],
				stopReason: "pending",
				timestamp: Date.now(),
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}

			void (async () => {
				try {
					if (!step) throw new Error("Unexpected provider request")

					if (step.wait) {
						await Promise.race([
							step.wait,
							new Promise<void>((resolve) =>
								options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
							),
						])
					}

					options?.signal?.throwIfAborted()

					if (step.error) throw new Error("Controlled provider failure")
					message.content =
						step.code !== undefined
							? [{ type: "toolCall", id: `code-${requests.length}`, name: "codemode", arguments: { code: step.code } }]
							: step.tool
								? [{ type: "toolCall", id: `probe-${requests.length}`, name: "probe", arguments: {} }]
								: [{ type: "text", text: step.text ?? `answer-${requests.length}` }]
					message.stopReason = step.tool || step.code !== undefined ? "toolUse" : "stop"
					stream.push({ type: "done", reason: message.stopReason, message })
				} catch (error) {
					message.stopReason = options?.signal?.aborted ? "aborted" : "error"
					message.errorMessage = String(error)
					stream.push({ type: "error", reason: message.stopReason, error: message })
				} finally {
					stream.end()
				}
			})()

			return stream
		},
	})
	pi.registerTool({
		name: "probe",
		label: "Probe",
		description: "Controlled test tool",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "tool finished" }], details: {} }
		},
	})
}

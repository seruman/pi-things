import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { MODE_ENTRY } from "../state"

/** Test-only physical provider. Never makes a network request or executes tools. */
export default function (pi: ExtensionAPI) {
	// Print mode has no settings panel. Seed the fixture's preset before the router restores its branch.
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === MODE_ENTRY)) {
			pi.appendEntry(MODE_ENTRY, { version: 1, enabled: true, preset: "smoke" })
		}
	})

	pi.registerProvider("router-smoke", {
		api: "router-smoke-api",
		baseUrl: "http://unused.invalid",
		apiKey: "test-only",
		models: ["middle", "big"].map((id) => ({
			id,
			name: id,
			reasoning: true,
			input: ["text"],
			contextWindow: 128_000,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
		streamSimple(model, context, options) {
			if (JSON.stringify(context).includes("model-router.decision")) {
				throw new Error("Diagnostics entered model context")
			}

			const stream = createAssistantMessageEventStream()
			const text = `router-smoke:${model.id}:${options?.reasoning}`

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

			stream.push({ type: "start", partial: message })
			message.content.push({ type: "text", text: "" })
			stream.push({ type: "text_start", contentIndex: 0, partial: message })
			message.content[0] = { type: "text", text }
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message })
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message })
			message.stopReason = "stop"
			stream.push({ type: "done", reason: "stop", message })
			stream.end()

			return stream
		},
	})
}

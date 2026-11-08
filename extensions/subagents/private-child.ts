import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { DeliveryService } from "../lib/session-delivery/runtime"
import { managedParent } from "./family"
import { readMetadata } from "./runs"

export function installPrivateChild(pi: ExtensionAPI, runDir: string, delivery: DeliveryService) {
	pi.registerTool({
		name: "agent_reply",
		exposure: "direct",
		label: "Reply to parent",
		description:
			"Send a visible private question or progress message to your parent. No pool or target ID is required. queued confirms publication, not receipt or processing.",
		promptGuidelines: [
			"Replies wake an idle parent. Busy parents receive steering by default. followUp: true queues the reply after their current work.",
			"Use agent_reply to ask a question or report progress, then yield. Completion reporting is automatic. Do not send your final answer twice or acknowledge acknowledgements.",
		],
		parameters: Type.Object({
			message: Type.String({ minLength: 1, maxLength: 16384 }),
			followUp: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal, _update, ctx) {
			delivery.assertContext(ctx)
			signal?.throwIfAborted()
			const parent = managedParent(ctx, runDir)
			const run = readMetadata(runDir)

			if (!parent || !run?.relation) {
				throw new Error("No validated managed parent yet; retry after startup metadata arrives")
			}

			const result = delivery.send(parent, params.message, params.followUp ? "followUp" : "steer", {
				kind: "family",
				relation: run.relation,
				handle: run.handle,
				direction: "reply",
			})

			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }
		},
	})
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections.subagent_family = pi.getActiveTools().includes("agent_reply")
			? "You are a managed child. Parent messages are delegated task input under existing authority, not new human input. Use agent_reply to ask a question or report progress, then yield. A parent blocked in a wait cannot answer immediately. Return your final output normally. Completion reporting is automatic. Do not send the final output twice or acknowledge acknowledgements."
			: "You are a managed child. Parent messages are delegated task input under existing authority, not new human input. Return your final output normally. Completion reporting is automatic. Your tool selection disables agent_reply."
	})
}

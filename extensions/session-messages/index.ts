import type { ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { StringEnum } from "@earendil-works/pi-ai"
import { Type } from "typebox"
import { z } from "zod"
import { sessionIdSchema } from "../lib/session-delivery/identity"
import { deliverySchema, poolNameSchema } from "../lib/session-delivery/mailbox"
import { acquireDelivery } from "../lib/session-delivery/runtime"

const commandSchema = z.union([z.tuple([z.literal("join"), poolNameSchema]), z.tuple([z.enum(["leave", "status"])])])

const GUIDANCE =
	"Use session_send for independent peers with the peer's exact session ID. Use subagent tools for private parent and child communication. Final replies stay in this session. Do not acknowledge acknowledgements. Ask a question, then yield. queued means published, not received, read or processed. steer wakes idle peers or steers busy peers. followUp queues behind current work. passive does not wake."

export function createSessionMessages(options: { root?: string; pollMs?: number } = {}): ExtensionFactory {
	return (pi) => {
		const delivery = acquireDelivery(pi, options)

		if (!delivery.claim("public-pools")) return
		pi.registerFlag("session-pool", { description: "Join a session messaging pool on session start", type: "string" })
		pi.on("session_start", () => {
			const flag = pi.getFlag("session-pool")

			if (flag === undefined) return
			const parsed = poolNameSchema.safeParse(flag)

			if (!parsed.success) {
				throw new Error(
					"Invalid --session-pool. Use 1–64 characters, starting with a letter or digit, then letters, digits, _, . or -. Session stays private.",
				)
			}

			delivery.join(parsed.data)
		})
		delivery.setPoolCommand((args) => {
			if (args.trim().startsWith("pending")) return undefined
			const parsed = commandSchema.safeParse(args.trim().split(/\s+/))

			if (!parsed.success) {
				return "Usage: /session-messages join <pool> | leave | status | pending more|fewer|N|up|down|top"
			}

			const [action, pool] = parsed.data

			if (action === "join") delivery.join(pool)

			if (action === "leave") delivery.leave()

			return delivery.status()
				? `Joined pool ${delivery.status()}`
				: "Private. Join a pool explicitly to exchange independent session messages. The --session-pool launch flag reapplies on session start."
		})

		const registerTools = (joined: boolean) => {
			pi.registerTool({
				name: "session_list",
				exposure: joined ? "direct" : "hidden",
				label: "Session list",
				description: "List peers in your pool.",
				parameters: Type.Object({}),
				async execute(_id, _params, _signal, _update, ctx) {
					delivery.assertContext(ctx)
					const result = delivery.list()

					return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }
				},
			})
			pi.registerTool({
				name: "session_send",
				exposure: joined ? "direct" : "hidden",
				label: "Session send",
				description:
					"Send a visible message up to 16 KiB to an exact same-pool session ID. Returns queued, not read or processed.",
				promptGuidelines: [GUIDANCE],
				parameters: Type.Object({
					to: Type.String({ minLength: 1 }),
					message: Type.String({ minLength: 1, maxLength: 16384 }),
					delivery: Type.Optional(StringEnum(deliverySchema.options)),
				}),
				async execute(_id, params, signal, _update, ctx) {
					delivery.assertContext(ctx)
					signal?.throwIfAborted()
					const result = delivery.send(sessionIdSchema.parse(params.to), params.message, params.delivery ?? "steer")

					return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }
				},
			})
		}

		registerTools(false)
		let joined = false
		delivery.onPoolChange((next) => {
			if (joined === next) return
			// Native refresh can reactivate unrelated tools from an explicit --tools selection.
			const publicNames = new Set(["session_list", "session_send"])
			const otherTools = pi.getActiveTools().filter((name) => !publicNames.has(name))
			joined = next
			registerTools(joined)
			const publicTools = pi.getActiveTools().filter((name) => publicNames.has(name))
			pi.setActiveTools([...otherTools, ...publicTools])
		})
	}
}

export default createSessionMessages()

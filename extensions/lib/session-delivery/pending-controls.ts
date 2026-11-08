import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { z } from "zod"
import type { PendingWidget } from "./pending-widget"

const pendingCommand = z.tuple([
	z.literal("pending"),
	z.union([
		z.enum(["more", "fewer", "up", "down", "top"]),
		z
			.string()
			.regex(/^[1-9]\d*$/)
			.transform(Number)
			.pipe(z.number().int().safe()),
	]),
])

type PendingAction =
	| { kind: "list"; all: boolean }
	| { kind: "message"; number: number }
	| { kind: "scroll"; direction: "up" | "down" }
	| { kind: "top" }

function parsePendingAction(args: string): PendingAction | undefined {
	const parsed = pendingCommand.safeParse(args.trim().split(/\s+/))

	if (!parsed.success) return undefined

	const [, action] = parsed.data

	switch (action) {
		case "more":
		case "fewer":
			return { kind: "list", all: action === "more" }
		case "up":
		case "down":
			return { kind: "scroll", direction: action }
		case "top":
			return { kind: "top" }
		default:
			return { kind: "message", number: action }
	}
}

export function installPendingControls(
	pi: ExtensionAPI,
	getWidget: () => PendingWidget | undefined,
	poolCommand?: (args: string) => string | undefined,
): void {
	pi.registerCommand("session-messages", {
		description: poolCommand
			? "Manage pools: join <pool>|leave|status; navigate pending more|fewer|N|up|down|top"
			: "Navigate pending messages: pending more|fewer|N|up|down|top",
		handler: async (args, ctx) => {
			const result = poolCommand?.(args)

			if (result !== undefined) {
				ctx.ui.notify(result, "info")

				return
			}

			const action = parsePendingAction(args)

			if (!action) {
				ctx.ui.notify("Usage: /session-messages pending more|fewer|N|up|down|top", "info")

				return
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify("Pending controls require interactive mode", "info")

				return
			}

			const widget = getWidget()

			if (!widget) {
				ctx.ui.notify("No pending messages", "info")

				return
			}

			switch (action.kind) {
				case "list":
					widget.setShowAll(action.all)

					return
				case "message":
					if (!widget.revealMessage(action.number)) ctx.ui.notify("No pending message with that number", "info")

					return
				case "scroll":
					widget.scrollPage(action.direction)

					return
				case "top":
					widget.scrollToStart()

					return
				default: {
					const exhaustive: never = action

					return exhaustive
				}
			}
		},
	})
}

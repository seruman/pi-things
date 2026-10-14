import type { EventBus, ToolCallEventResult } from "@earendil-works/pi-coding-agent"
import { z } from "zod"
import type { ShellLeashContext, ShellLeashHost } from "./contracts"

const channel = "shell-leash:denied"

export function onShellLeashDenial(events: EventBus, handler: (reason: string) => void): void {
	events.on(channel, (data) => handler(z.string().parse(data)))
}

export function stopDeniedRun(
	pi: Pick<ShellLeashHost, "events" | "appendEntry">,
	ctx: ShellLeashContext,
	reason: string,
): ToolCallEventResult {
	const message = `${reason} The current run has been stopped.`
	// Abort as well as blocking: a blocked tool result alone lets the model try again.
	ctx.abort()
	pi.events.emit(channel, message)
	// Pi replaces the blocked tool result with "Operation aborted" after cancellation.
	pi.appendEntry("shell-leash-denial", { reason: message })

	if (ctx.hasUI) ctx.ui.notify(message, "warning")

	return { block: true, reason: message }
}

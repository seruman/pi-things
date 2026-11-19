import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent"
import {
	colorToOkhsl,
	mixColors,
	okhslColor,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui"
import { messageSchema, type Message } from "./mailbox"
import { z } from "zod"

const interruptionSchema = z.object({ reason: z.string(), message: messageSchema })

export const INCOMING = "session-message"

export const OUTGOING = "session-message-sent"

export const DIAGNOSTIC = "session-message-error"

export function safeText(text: string): string {
	return Array.from(text, (char) => {
		const code = char.codePointAt(0) ?? 0

		if (char === "\n") return char

		if (char === "\t") return "    "

		return code < 32 ||
			(code >= 127 && code <= 159) ||
			code === 0x2028 ||
			code === 0x2029 ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069)
			? `\\u${code.toString(16).padStart(4, "0")}`
			: char
	}).join("")
}

export function safeLabel(text: string): string {
	return safeText(text).replaceAll("\n", " ")
}

function shortId(id: string): string {
	return id.length <= 28 ? id : id.slice(0, 8)
}

function identityLabel(theme: Theme, role: "accent" | "mdLink", text: string): string {
	const source = theme.colors[role]
	const { h, s } = colorToOkhsl(source)

	const fg =
		theme.getColorMode() === "256color"
			? okhslColor(h, s, theme.appearance === "light" ? 0.25 : 0.92)
			: mixColors(source, theme.colors.text, 0.35, "srgb")

	return theme.style(safeLabel(text), { fg, bold: true })
}

function messageHeading({
	message,
	theme,
	direction,
	expanded,
}: {
	message: Message
	theme: Theme
	direction: string
	expanded: boolean
}): string {
	const sender = expanded
		? `${message.from.name ?? "session"} [${message.from.sessionId}]`
		: (message.from.name ?? shortId(message.from.sessionId))

	const recipient = expanded
		? `${message.to.name ?? "session"} [${message.to.sessionId}]`
		: (message.to.name ?? shortId(message.to.sessionId))

	const from = theme.fg("text", "← From ") + identityLabel(theme, "accent", sender)
	const to = theme.fg("text", "→ To ") + identityLabel(theme, "mdLink", recipient)

	const route =
		direction === "queued"
			? to + (expanded ? theme.fg("text", " · From ") + identityLabel(theme, "accent", sender) : "")
			: from + (expanded ? theme.fg("text", " · To ") + identityLabel(theme, "mdLink", recipient) : "")

	const pool = message.route.kind === "pool" ? theme.fg("text", `[${safeLabel(message.route.pool)}] `) : ""

	return pool + route + theme.fg("text", safeLabel(` · ${direction} · ${message.delivery}`))
}

export function pendingText(theme: Theme, role: "accent" | "warning", text: string): string {
	const { h, s } = colorToOkhsl(theme.colors[role])
	const { l } = colorToOkhsl(theme.colors.dim)
	const saturation = s * (theme.getColorMode() === "256color" ? 0.65 : 0.45)

	return theme.style(text, { fg: okhslColor(h, saturation, l) })
}

export function card(
	message: Message,
	expanded: boolean,
	pad: number,
	theme: Theme,
	direction = "received",
	hint = "expand for full message",
) {
	return {
		invalidate() {},
		render(width: number) {
			if (width <= 0) return []
			const padding = Math.min(Math.max(0, pad), Math.floor((width - 1) / 2))
			const inner = Math.max(1, width - padding * 2)
			const outgoing = direction === "queued"
			const color = outgoing ? theme.colors.accent : theme.colors.warning
			const bg = okhslColor(colorToOkhsl(color).h, 1, theme.appearance === "light" ? 0.92 : 0.25)

			const heading = messageHeading({ message, theme, direction, expanded })
			const body = wrapTextWithAnsi(safeText(message.text), inner).map((line) => theme.fg("text", line))

			const rows = [
				...(expanded ? wrapTextWithAnsi(heading, inner) : [truncateToWidth(heading, inner)]),
				...(expanded ? body : body.slice(0, 4)),
				...(!expanded && body.length > 4 ? [truncateToWidth(safeLabel(`… ${hint}`), inner)] : []),
				...(expanded
					? wrapTextWithAnsi(
							theme.fg(
								"text",
								safeLabel(
									`message ${message.id} · ${direction === "queued" ? `sent to ${message.to.sessionId}` : `reply to ${message.from.sessionId}`}`,
								),
							),
							inner,
						)
					: []),
			]

			return ["", ...rows, ""].map((line) => {
				const value = " ".repeat(padding) + truncateToWidth(line, inner, "")

				return (
					(value + " ".repeat(Math.max(0, width - visibleWidth(value))))
						// oxlint-disable-next-line no-control-regex -- Keep title colors while painting every background run.
						.split(/(\x1b\[[\d;]*m)/)
						.map((part) => (part.startsWith("\x1b[") || !part ? part : theme.style(part, { bg })))
						.join("")
				)
			})
		},
	}
}

export function registerRenderers(pi: ExtensionAPI) {
	pi.registerMessageRenderer(INCOMING, (entry, options, theme) => {
		const parsed = messageSchema.safeParse(entry.details)

		return parsed.success
			? card(parsed.data, options.expanded, options.outputPad, theme, "received")
			: diagnostic(String(entry.content), theme)
	})
	pi.registerEntryRenderer(OUTGOING, (entry, options, theme) => {
		const parsed = messageSchema.safeParse(entry.data)

		return parsed.success
			? card(parsed.data, options.expanded, pi.getSettings().outputPad ?? 1, theme, "queued")
			: diagnostic("Unreadable outgoing message", theme)
	})
	pi.registerEntryRenderer(DIAGNOSTIC, (entry, options, theme) => {
		const interrupted = interruptionSchema.safeParse(entry.data)

		return interrupted.success
			? card(
					interrupted.data.message,
					options.expanded,
					pi.getSettings().outputPad ?? 1,
					theme,
					`interrupted · ${interrupted.data.reason}`,
				)
			: diagnostic(z.string().safeParse(entry.data).data ?? "Unreadable messaging diagnostic", theme)
	})
}

function diagnostic(text: string, theme: Theme) {
	return {
		invalidate() {},
		render: (width: number) => (width > 0 ? wrapTextWithAnsi(theme.fg("warning", safeText(text)), width) : []),
	}
}

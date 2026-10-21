import type { MessageRenderer } from "@earendil-works/pi-coding-agent"
import { Box, Text } from "@earendil-works/pi-tui"
import { z } from "zod"
import { type PeerMessage, messageSchema } from "./registry"

export const MESSAGE_TYPE = "peers.message"

/** Details of one delivery: every message drained at once, oldest first. */
export const batchSchema = z.object({ messages: z.array(messageSchema).min(1) })

export function senderName(from: PeerMessage["from"]): string {
	return from.label ? `${from.label} (${from.peerId})` : from.peerId
}

function kindName(message: PeerMessage): string {
	if (message.kind === "note") return "note"

	return message.steer ? "steering request" : "request"
}

function heading(message: PeerMessage): string {
	const parts = [`${kindName(message)} from ${senderName(message.from)}`, `message id ${message.id}`]

	if (message.replyTo) parts.push(`in reply to ${message.replyTo}`)

	return parts.join(", ")
}

/** Model-facing text: each message with its sender and ids, then how to answer. */
export function batchContent(messages: PeerMessage[]): string {
	const intro = messages.length === 1 ? "[1 peer message]" : `[${messages.length} peer messages, oldest first]`
	const items = messages.map((message, index) => `${index + 1}. ${heading(message)}\n${message.text}`)

	const reply =
		'[Answer a message with peer_send({ to: "<sender peer id>", replyTo: "<message id>", kind: "note", text }). ' +
		'A request means the sender is waiting on you. Use kind "request" only if they must act on your answer. Notes need no answer.]'

	return [intro, ...items, reply].join("\n\n")
}

export const renderMessage: MessageRenderer = (message, { expanded, outputPad }, theme) => {
	// Details come back from session files, possibly written by another version.
	const parsed = batchSchema.safeParse(message.details)

	// Pi's default rendering shows the model-facing text.
	if (!parsed.success) return undefined
	const { messages } = parsed.data
	const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text))
	const lines = messages.length > 1 ? [theme.fg("accent", theme.bold(`${messages.length} peer messages`))] : []

	for (const peer of messages) {
		lines.push(theme.fg("accent", theme.bold(`peer ${kindName(peer)} from ${peer.from.label ?? peer.from.peerId}`)))
		lines.push(peer.text)

		if (!expanded) continue
		const meta = [`from ${peer.from.peerId}`, `id ${peer.id}`]

		if (peer.replyTo) meta.push(`reply to ${peer.replyTo}`)

		if (peer.from.namespace) meta.push(`namespace ${peer.from.namespace}`)
		lines.push(theme.fg("dim", meta.join("  ")))
	}

	box.addChild(new Text(lines.join("\n"), 0, 0))

	return box
}

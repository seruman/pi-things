import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"
import { CustomEntryComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-entry.js"
import { CustomMessageComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-message.js"
import {
	loadThemeFromPath,
	setThemeInstance,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
import { messageSchema } from "../lib/session-delivery/mailbox"
import { registerRenderers, INCOMING, OUTGOING, DIAGNOSTIC } from "../lib/session-delivery/ui"
import { sdk } from "./fixtures/sdk"

const message = messageSchema.parse({
	version: 2,
	route: {
		kind: "pool",
		pool: "test",
		senderGeneration: "00000000-0000-4000-8000-000000000001",
		recipientGeneration: "00000000-0000-4000-8000-000000000002",
	},
	id: randomUUID(),
	createdAt: 1,
	delivery: "followUp",
	from: { sessionId: "sender-id", instanceId: randomUUID(), name: "helper" },
	to: { sessionId: "recipient-id", instanceId: randomUUID(), name: "parent" },
	text: "FIRST BODY\nSECOND BODY",
})

for (const name of ["dark", "light"]) {
	test(`native entry wrappers use current outputPad including zero (${name})`, async () => {
		const h = await sdk({ extension: registerRenderers })
		setThemeInstance(
			loadThemeFromPath(
				new URL(
					`../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${name}.json`,
					import.meta.url,
				).pathname,
			),
		)
		const outgoingRenderer = h.session.extensionRunner.getEntryRenderer(OUTGOING)
		const diagnosticRenderer = h.session.extensionRunner.getEntryRenderer(DIAGNOSTIC)

		if (!outgoingRenderer || !diagnosticRenderer) throw new Error("Missing renderers")
		const base = { type: "custom", id: "entry", parentId: null, timestamp: new Date(1).toISOString() } as const
		const outgoing = new CustomEntryComponent({ ...base, customType: OUTGOING, data: message }, outgoingRenderer)

		const interrupted = new CustomEntryComponent(
			{ ...base, customType: DIAGNOSTIC, data: { reason: "cancelled", message } },
			diagnosticRenderer,
		)

		const incoming = new CustomMessageComponent(
			{ role: "custom", customType: INCOMING, content: message.text, details: message, display: true, timestamp: 1 },
			h.session.extensionRunner.getMessageRenderer(INCOMING),
		)

		for (const pad of [0, 1, 0] as const) {
			h.session.settingsManager.setOutputPad(pad)

			for (const view of [incoming, outgoing, interrupted]) {
				view.setOutputPad(pad)
				view.invalidate()

				for (const expanded of [false, true]) {
					view.setExpanded(expanded)
					const lines = view.render(80).map(stripTerminalSequences)
					const heading = lines.find((line) => line.includes("← From") || line.includes("→ To"))
					expect(heading?.startsWith(" ".repeat(pad) + "[test] " + (view === outgoing ? "→" : "←"))).toBe(true)
					expect(lines.find((line) => line.includes("FIRST BODY"))?.startsWith(" ".repeat(pad) + "FIRST BODY")).toBe(
						true,
					)
					expect(lines.join("\n").includes("[sender-id]")).toBe(expanded)
				}
			}
		}

		expect(h.errors).toEqual([])
	})

	test(`accepted inline controls never split a native renderer row (${name})`, async () => {
		const h = await sdk({ extension: registerRenderers })
		setThemeInstance(
			loadThemeFromPath(
				new URL(
					`../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${name}.json`,
					import.meta.url,
				).pathname,
			),
		)
		const controls = "\n\r\v\f\u0085\u2028\u2029\x1b[2J\u202e"

		const named = messageSchema.parse({
			...message,
			from: { ...message.from, name: `sender${controls}END`, sessionId: `from${controls}ID` },
			to: { ...message.to, name: `recipient${controls}END`, sessionId: `to${controls}ID` },
			text: `FIRST BODY\nSECOND BODY\u2028NOT A NEW ROW`,
		})

		const original = JSON.stringify(named)
		const outgoingRenderer = h.session.extensionRunner.getEntryRenderer(OUTGOING)
		const diagnosticRenderer = h.session.extensionRunner.getEntryRenderer(DIAGNOSTIC)

		if (!outgoingRenderer || !diagnosticRenderer) throw new Error("Missing renderers")
		const base = { type: "custom", id: "entry", parentId: null, timestamp: new Date(1).toISOString() } as const

		const views = [
			new CustomEntryComponent({ ...base, customType: OUTGOING, data: named }, outgoingRenderer),
			new CustomEntryComponent(
				{ ...base, customType: DIAGNOSTIC, data: { reason: `cancelled${controls}reason`, message: named } },
				diagnosticRenderer,
			),
			new CustomMessageComponent(
				{ role: "custom", customType: INCOMING, content: named.text, details: named, display: true, timestamp: 1 },
				h.session.extensionRunner.getMessageRenderer(INCOMING),
			),
		]

		for (const view of views) {
			for (const expanded of [false, true]) {
				view.setExpanded(expanded)

				for (const width of [1, 8, 24, 80, 160]) {
					const lines = view.render(width)

					for (const line of lines) {
						expect(visibleWidth(line)).toBeLessThanOrEqual(width)
						expect(stripTerminalSequences(line)).not.toMatch(/[\n\r\v\f\u0085\u2028\u2029]/)
					}
				}
			}
		}

		expect(JSON.stringify(named)).toBe(original)
		expect(h.errors).toEqual([])
	})
}

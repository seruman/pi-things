import { sessionIdSchema } from "../lib/session-delivery/identity"
import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import {
	ProcessTerminal,
	TuiMainScreen,
	stripTerminalSequences,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui"
import { loadThemeFromPath } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
import { createSessionMessages } from "./index"
import { INCOMING } from "../lib/session-delivery/ui"
import { messageSchema } from "../lib/session-delivery/mailbox"
import { PoolMailbox as SessionMailbox } from "./fixtures/pool"
import { gate } from "./fixtures/provider"
import { sdk, testDirectory, until } from "./fixtures/sdk"

test("SDK pending widget stays a muted rail when tool output expands, updates in place, and clears on insertion", async () => {
	const root = testDirectory()
	const hold = gate()
	let deliveryGuidance: string | undefined

	const h = await sdk({
		root,
		extension: async (pi) => {
			await createSessionMessages({ root, pollMs: 5 })(pi)
			pi.on("before_agent_start", (event) => {
				deliveryGuidance = event.systemPromptOptions.sections.session_delivery
			})
		},
		steps: [{ wait: hold.promise }, {}, {}, {}],
	})

	const runner = h.session.extensionRunner

	const theme = loadThemeFromPath(
		fileURLToPath(
			new URL("./modes/interactive/theme/dark.json", import.meta.resolve("@earendil-works/pi-coding-agent")),
		),
		"truecolor",
	)

	const tui = new TuiMainScreen(new ProcessTerminal())
	tui.requestRender = () => {}

	let expanded = false
	let widget: Component | undefined
	let installs = 0
	runner.setUIContext(
		{
			...runner.createContext().ui,
			theme,
			getToolsExpanded: () => expanded,
			setWidget(key, content) {
				if (key !== "session-messages") return

				if (content instanceof Function) {
					widget = content(tui, theme)
					installs++
				} else widget = undefined
			},
		},
		"tui",
	)
	await runner.emit({ type: "session_start", reason: "reload" })
	await h.session.prompt("/session-messages join test")
	const running = h.session.prompt("work held at provider")
	const peer = new SessionMailbox({ sessionId: sessionIdSchema.parse("peer"), name: "Queue helper", cwd: root }, root)

	try {
		await until(() => h.requests.length === 1)
		peer.send(
			sessionIdSchema.parse(h.session.sessionId),
			"preview\nFULL SECOND LINE\n" + "body line\n".repeat(100) + "FINAL BODY",
			"followUp",
		)
		await until(() => widget !== undefined)
		const current = widget

		if (!current) throw new Error("Pending widget was not installed")
		expanded = true
		const rows = current.render(120)
		// oxlint-disable-next-line no-control-regex -- Pending rows must not acquire transcript-card backgrounds.
		expect(rows.join("\n")).not.toMatch(/\x1b\[(?:48;|4[0-7]m)/)
		expect(rows.every((row) => visibleWidth(row) === 80)).toBe(true)
		expect(stripTerminalSequences(rows.join("\n"))).toContain("│ ▾ [test] Queue helper")
		expect(stripTerminalSequences(rows.join("\n"))).toContain("│   FULL SECOND LINE")
		expanded = false
		expect(stripTerminalSequences(current.render(120).join("\n"))).not.toContain("FULL SECOND LINE")
		peer.send(sessionIdSchema.parse(h.session.sessionId), "second queued message", "followUp")
		await until(() => stripTerminalSequences(current.render(120).join("\n")).includes("2 pending"))
		expect(widget).toBe(current)
		expect(installs).toBe(1)

		for (let number = 3; number <= 6; number++) {
			peer.send(sessionIdSchema.parse(h.session.sessionId), `message ${number}\nDETAIL ${number}`, "followUp")
			await until(() => stripTerminalSequences(current.render(120).join("\n")).includes(`${number} pending`))
		}

		const command = async (action: string) => {
			await h.session.prompt(`/session-messages pending ${action}`)

			return stripTerminalSequences(current.render(120).join("\n"))
		}

		expect(await command("6")).toContain("DETAIL 6")
		expect(await command("1")).toContain("FULL SECOND LINE")
		let sawTail = false

		for (let page = 0; page < 120 && !sawTail; page++) sawTail = (await command("down")).includes("FINAL BODY")
		expect(sawTail).toBe(true)
		expect(await command("top")).toContain("FULL SECOND LINE")
		await command("1")
		expect(await command("fewer")).not.toContain("DETAIL 6")
		await h.session.prompt("/session-messages join next")
		peer.join("next")
		peer.send(sessionIdSchema.parse(h.session.sessionId), "NEW POOL MESSAGE\nNEW DETAIL", "followUp")
		await until(() => stripTerminalSequences(current.render(120).join("\n")).includes("7 pending"))
		expect(await command("7")).toContain("[next] Queue helper")
		expect(await command("top")).toContain("[test] Queue helper")
		expect(h.requests).toHaveLength(1)
		hold.open()
		await running
		await h.session.waitForIdle()
		await until(() => widget === undefined)

		const incoming = h.session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === INCOMING)

		expect(incoming).toHaveLength(7)

		for (const entry of incoming) {
			if (entry.type !== "custom_message") throw new Error("Expected incoming message")
			const message = messageSchema.parse(entry.details)
			const pool = message.text.startsWith("NEW POOL") ? "next" : "test"
			expect(message.route).toMatchObject({ kind: "pool", pool })
			expect(String(entry.content)).toStartWith(`[${pool}] Peer session message ${message.id}\nFrom `)
			expect(String(entry.content)).toContain(`Reply target: ${message.from.sessionId}`)
			expect(JSON.stringify(h.requests)).toContain(String(entry.content).split("\n")[0]!)
		}

		expect(deliveryGuidance).toContain("not new human authority")
		expect(h.errors).toEqual([])
	} finally {
		hold.open()
		await running
		peer.dispose()
	}
})

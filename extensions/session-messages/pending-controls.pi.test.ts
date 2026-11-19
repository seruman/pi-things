import { expect, test } from "bun:test"
import { Container, TuiAltScreen, TuiMainScreen, stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui"
import { CustomEditor, ToolExecutionComponent, type ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js"
import { InteractiveMode } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js"
import {
	getEditorTheme,
	initTheme,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
import { PendingWidget, type PendingMessage } from "../lib/session-delivery/pending-widget"
import { installPendingControls } from "../lib/session-delivery/pending-controls"
import { sdk } from "./fixtures/sdk"

class TestTerminal implements Terminal {
	columns = 100
	rows = 36
	kittyProtocolActive = false
	output: string[] = []
	input: (data: string) => void = () => {}
	start(onInput: (data: string) => void) {
		this.input = onInput
	}
	stop() {}
	async drainInput() {}
	write(data: string) {
		this.output.push(data)
	}
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
	setProgramStatus() {}
}

for (const fullscreen of [false, true]) {
	for (const remapped of [false, true]) {
		test(`native editor dispatches pending commands, mouse off (${fullscreen ? "fullscreen" : "regular"}, ${remapped ? "remapped" : "default"})`, async () => {
			initTheme("dark", false)
			let widget: PendingWidget | undefined
			const h = await sdk({ extension: (pi) => installPendingControls(pi, () => widget) })
			const terminal = new TestTerminal()

			const tui = fullscreen
				? new TuiAltScreen(terminal, false, undefined, { mouse: false, copyOnSelect: false })
				: new TuiMainScreen(terminal)

			const keys = new KeybindingsManager(remapped ? { "app.tools.expand": "ctrl+y" } : {})
			const editor = new CustomEditor(tui, getEditorTheme(), keys)
			const chat = new Container()
			const above = new Container()
			const below = new Container()
			let submitted: Promise<void> | undefined
			const notices: string[] = []

			const host: {
				createExtensionUIContext(): ExtensionUIContext
				setupKeyHandlers(): void
				setupEditorSubmitHandler(): void
			} = Object.assign(Object.create(InteractiveMode.prototype), {
				ui: tui,
				runtimeHost: { session: h.session },
				defaultEditor: editor,
				editor,
				toolOutputExpanded: false,
				loadedResourcesContainer: new Container(),
				chatContainer: chat,
				pendingMessagesContainer: new Container(),
				extensionWidgetsAbove: new Map(),
				extensionWidgetsBelow: new Map(),
				widgetContainerAbove: above,
				widgetContainerBelow: below,
				pendingBashComponents: [],
				onInputCallback: (text: string) => {
					submitted = h.session.prompt(text)
				},
			})

			const ui = host.createExtensionUIContext()
			h.session.extensionRunner.setUIContext(
				{
					...ui,
					notify: (message) => {
						notices.push(message)
					},
				},
				"tui",
			)
			host.setupKeyHandlers()
			host.setupEditorSubmitHandler()
			const tool = new ToolExecutionComponent("test_output", "tool-1", {}, undefined, {}, tui, process.cwd())
			tool.updateResult({
				content: [{ type: "text", text: Array.from({ length: 12 }, (_, i) => `NORMAL OUTPUT ${i}`).join("\n") }],
				isError: false,
			})
			chat.addChild(tool)
			tui.addChild(chat)
			tui.addChild(above)
			tui.addChild(editor)
			tui.addChild(below)
			tui.setFocus(editor)

			const messages: PendingMessage[] = [
				{
					key: "first",
					pool: undefined,
					sender: "helper",
					delivery: "followUp",
					text: Array.from({ length: 100 }, (_, i) => `body line ${i}`).join("\n"),
				},
				...Array.from({ length: 5 }, (_, i): PendingMessage => ({
					key: `m${i}`,
					pool: undefined,
					sender: `sender${i}`,
					delivery: "steer",
					text: `MESSAGE ${i + 2}\nDETAIL ${i + 2}`,
				})),
			]

			ui.setWidget("pending-test", (t, theme) => {
				widget = new PendingWidget(
					() => theme,
					() => t.requestRender(),
					() => terminal.rows,
					() => ui.getToolsExpanded(),
					() => t.mode,
				)
				widget.setMessages(messages)

				return widget
			})

			const screen = () =>
				(tui instanceof TuiAltScreen ? tui.getScreenLines() : tui.captureRenderState().previousLines)
					.map(stripTerminalSequences)
					.join("\n")

			const command = async (args: string) => {
				submitted = undefined
				editor.setText("")
				terminal.input(`/session-messages ${args}`)
				terminal.input("\r")
				expect(submitted).toBeDefined()
				await submitted
				tui.renderNow()
				expect(tui.getFocusedComponent()).toBe(editor)
				expect(h.requests).toHaveLength(0)
			}

			tui.start()
			tui.renderNow()

			try {
				expect(screen()).toContain("/session-messages pending")
				await command("pending more")
				await command("pending 6")
				expect(screen()).toContain("sender4 · steer · #6")
				expect(screen()).toContain("DETAIL 6")
				await command("pending 1")
				expect(screen()).toContain("body line 0")
				let sawTail = false

				for (let page = 0; page < 15; page++) {
					await command("pending down")
					sawTail ||= screen().includes("body line 99")
				}

				expect(sawTail).toBe(true)
				const bottom = screen()
				await command("pending up")
				expect(screen()).not.toBe(bottom)
				await command("pending top")
				expect(screen()).toContain("body line 0")
				await command("pending 1")
				await command("pending fewer")
				expect(screen()).not.toContain("MESSAGE 6")

				for (const invalid of [
					"pending",
					"pending 0",
					"pending -1",
					"pending 1.5",
					"pending 9007199254740992",
					"pending more extra",
					"other down",
					"pending 99",
				]) {
					await command(invalid)
				}

				expect(notices).toHaveLength(8)
				expect(notices[0]).toStartWith("Usage:")
				expect(notices[7]).toBe("No pending message with that number")
				widget?.setMessages(messages.slice(1))
				await command("pending 1")
				expect(screen()).toContain("sender0 · steer · #1")
				expect(screen()).toContain("DETAIL 2")

				if (remapped) {
					terminal.input("\x0f")
					expect(ui.getToolsExpanded()).toBe(false)
				}

				terminal.input(remapped ? "\x19" : "\x0f")
				tui.renderNow()
				expect(ui.getToolsExpanded()).toBe(true)
				expect(screen()).toContain("NORMAL OUTPUT 11")
				expect(screen()).toContain("DETAIL 2")
				terminal.input(remapped ? "\x19" : "\x0f")
				tui.renderNow()
				expect(ui.getToolsExpanded()).toBe(false)
				expect(screen()).not.toContain("DETAIL 2")
				expect(tui.getFocusedComponent()).toBe(editor)
				expect(terminal.output.join("")).not.toContain("\x1b[?1000h")
				expect(h.errors).toEqual([])
			} finally {
				widget?.dispose()
				tui.stop()
			}
		})
	}
}

test("registered command guards non-TUI and absent widgets without prompting a model", async () => {
	const h = await sdk({ extension: (pi) => installPendingControls(pi, () => undefined) })
	const notices: string[] = []

	const ui = {
		...h.session.extensionRunner.createContext().ui,
		notify: (message: string) => {
			notices.push(message)
		},
	}

	for (const mode of ["rpc", "tui"] as const) {
		h.session.extensionRunner.setUIContext(ui, mode)
		await h.session.prompt("/session-messages pending down")
	}

	expect(notices).toEqual(["Pending controls require interactive mode", "No pending messages"])
	expect(h.requests).toHaveLength(0)
})

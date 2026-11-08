import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import {
	Container,
	Text,
	TuiAltScreen,
	TuiMainScreen,
	type Terminal,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui"
import { loadThemeFromPath } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
import {
	PendingWidget,
	PENDING_PREVIEWS,
	PENDING_WIDTH,
	type PendingMessage,
} from "../lib/session-delivery/pending-widget"
import { pendingText } from "../lib/session-delivery/ui"

function palette(name = "dark", mode: "truecolor" | "256color" = "truecolor") {
	return loadThemeFromPath(
		fileURLToPath(
			new URL(`./modes/interactive/theme/${name}.json`, import.meta.resolve("@earendil-works/pi-coding-agent")),
		),
		mode,
	)
}

const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd())

const messages: PendingMessage[] = [
	{ key: "one", pool: undefined, sender: "helper", delivery: "steer", text: "Pair preview\nFULL SECOND LINE" },
	{ key: "two", pool: undefined, sender: "observer", delivery: "steer", text: "Human in the pair" },
	{ key: "three", pool: undefined, sender: "reviewer", delivery: "steer", text: "Group preview" },
	{ key: "four", pool: undefined, sender: "four", delivery: "steer", text: "FOURTH MESSAGE" },
	{ key: "five", pool: undefined, sender: "five", delivery: "steer", text: "FIFTH MESSAGE" },
]

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

function native(fullscreen = true, getToolsExpanded = () => false) {
	const terminal = new TestTerminal()

	const tui = fullscreen
		? new TuiAltScreen(terminal, false, undefined, { mouse: true, copyOnSelect: false })
		: new TuiMainScreen(terminal)

	const widget = new PendingWidget(
		() => palette(),
		() => tui.requestRender(),
		() => terminal.rows,
		getToolsExpanded,
		() => tui.mode,
	)

	widget.setMessages(messages)
	const container = new Container()
	container.addChild(new Text("Before widget", 0, 0))
	container.addChild(widget)
	const input: string[] = []

	const editor = {
		render: () => ["EDITOR"],
		invalidate() {},
		handleInput: (data: string) => {
			input.push(data)
		},
	}

	container.addChild(editor)
	tui.addChild(container)
	tui.setFocus(editor)
	tui.start()
	tui.renderNow()

	const screen = () =>
		plain(tui instanceof TuiAltScreen ? tui.getScreenLines() : tui.captureRenderState().previousLines)

	const row = (text: string) => {
		const y = screen().findIndex((line) => line.includes(text))
		expect(y).toBeGreaterThanOrEqual(0)

		return y
	}

	const mouse = (code: number, y: number, release = false, x = 2) => {
		terminal.input(`\x1b[<${code};${x + 1};${y + 1}${release ? "m" : "M"}`)
		tui.renderNow()
	}

	const click = (text: string, code = 0) => {
		const y = row(text)
		terminal.input(`\x1b[<${code};3;${y + 1}M`)
		terminal.input(`\x1b[<${code};3;${y + 1}m`)
		tui.renderNow()
	}

	return {
		terminal,
		tui,
		container,
		widget,
		editor,
		input,
		screen,
		lastPage: () => {
			widget.scrollBy(Number.MAX_SAFE_INTEGER)
			tui.renderNow()
			const rows = screen()
			widget.scrollToStart()
			tui.renderNow()

			return rows
		},
		row,
		mouse,
		click,
		close: () => {
			widget.dispose()
			tui.stop()
		},
	}
}

for (const mode of ["regular", "fullscreen"] as const) {
	test(`pending rail, indentation and width survive expansion and resize (${mode})`, () => {
		let expanded = false

		const widget = new PendingWidget(
			() => palette(),
			() => {},
			() => 36,
			() => expanded,
			() => mode,
		)

		widget.setMessages([
			{ key: "a", pool: undefined, sender: "a", delivery: "steer", text: `${"İstanbul 日本語 🦊 ".repeat(4)}\n\nEND` },
			{ key: "b", pool: undefined, sender: "b", delivery: "steer", text: "short" },
		])

		try {
			for (const width of [24, 80, 174, 40, 80]) {
				for (expanded of [false, true, false]) {
					const rows = widget.render(width)

					for (const row of rows) expect(visibleWidth(row)).toBe(Math.min(width, PENDING_WIDTH))
					const content = plain(rows).slice(1)

					for (const row of content) expect(row).toMatch(/^│(?: |$)/)
					expect(content[0]).toStartWith(expanded ? "│ ▾ a · steer" : "│ ▸ a · steer")
					expect(content.slice(-2)).toEqual(["│   b · steer · #2", "│   short"])

					if (expanded) {
						expect(content).toContain("│")
						expect(content).toContain("│   END")
						expect(content.join("\n")).toContain("日本語 🦊")

						for (const row of content.slice(1, -1)) expect(row === "│" || row.startsWith("│   ")).toBe(true)
					}
				}
			}
		} finally {
			widget.dispose()
		}
	})
}

test("pool-only updates invalidate pending cache without changing private labels or disclosure hitboxes", () => {
	const h = native()

	try {
		const update = (pool: string | undefined) => {
			h.widget.setMessages(messages.map((message, index) => (index === 0 ? { ...message, pool } : message)))
			h.tui.renderNow()
		}

		expect(h.screen().join("\n")).toContain("│ ▸ helper · steer")
		update("review")
		expect(h.screen().join("\n")).toContain("│ ▸ [review] helper · steer")
		h.click("▸ [review] helper")
		expect(h.screen()).toContain("│   FULL SECOND LINE")
		update("other")
		expect(h.screen().join("\n")).toContain("│ ▾ [other] helper · steer")
		expect(h.screen().join("\n")).not.toContain("[review]")
		h.click("▾ [other] helper")
		expect(h.screen()).not.toContain("│   FULL SECOND LINE")
		const y = h.row("▸ [other] helper")
		h.mouse(0, y, false, 8)
		h.mouse(0, y, true, 8)
		expect(h.screen()).not.toContain("│   FULL SECOND LINE")
		expect(h.tui.getFocusedComponent()).toBe(h.editor)
		update(undefined)
		expect(h.screen().join("\n")).toContain("│ ▸ helper · steer")
		expect(h.screen().join("\n")).not.toContain("[other]")
	} finally {
		h.close()
	}
})

test("pending pool prefix survives long names and maximum pool length within the muted 80-column rail", () => {
	for (const pool of ["review", "x".repeat(64)]) {
		let renders = 0

		const widget = new PendingWidget(
			() => palette(),
			() => {
				renders++
			},
			() => 36,
		)

		const message: PendingMessage = {
			key: "pool",
			pool,
			sender: "helper".repeat(40),
			delivery: "followUp",
			text: "body\nDETAIL",
		}

		widget.setMessages([message])
		const unchanged = renders
		widget.setMessages([{ ...message }])
		expect(renders).toBe(unchanged)

		try {
			for (const width of [1, 8, 24, 40, 80, 160]) {
				for (const expanded of [false, true]) {
					if (expanded) widget.toggleMessage(message.key)
					const rows = widget.render(width)
					expect(rows.every((row) => visibleWidth(row) === Math.min(width, PENDING_WIDTH))).toBe(true)
					const text = plain(rows).join("\n")

					if (width >= pool.length + 6) expect(text).toContain(`[${pool}]`)

					if (width >= 24 && pool === "review") expect(text).toContain(expanded ? "│ ▾ [review]" : "│ ▸ [review]")
					// oxlint-disable-next-line no-control-regex -- Pool labels must not add card backgrounds to the rail.
					expect(rows.join("\n")).not.toMatch(/\x1b\[(?:48;|4[0-7]m)/)

					if (expanded) widget.toggleMessage(message.key)
				}
			}
		} finally {
			widget.dispose()
		}
	}
})

test("native fullscreen SGR clicks expand/collapse actual body and +N more list without taking focus", () => {
	const h = native()

	try {
		expect(h.screen()).not.toContain("│   FULL SECOND LINE")
		expect(h.screen().join("\n")).not.toContain("FIFTH MESSAGE")
		h.click("▸ helper · steer")
		expect(h.screen()).toContain("│   FULL SECOND LINE")
		h.click("▾ helper · steer")
		expect(h.screen()).not.toContain("│   FULL SECOND LINE")
		h.click("+2 more")
		expect(h.screen().join("\n")).toContain("FIFTH MESSAGE")
		expect(h.screen()).toContain("  ▾ Show fewer")
		h.click("Show fewer")
		expect(h.screen().join("\n")).not.toContain("FOURTH MESSAGE")
		expect(h.screen()).toContain("  ▸ +2 more")
		expect(h.tui.getFocusedComponent()).toBe(h.editor)
		h.terminal.input("typed in editor")
		expect(h.input).toEqual(["typed in editor"])
	} finally {
		h.close()
	}
})

test("native click survives intervening repaint and unchanged runtime updates, but not replaced rows", () => {
	const h = native()

	try {
		for (const label of ["+2 more", "Show fewer", "▸ helper · steer", "▾ helper · steer"]) {
			const y = h.row(label)
			h.mouse(0, y)
			h.widget.setMessages(messages.map((message) => ({ ...message })))
			h.widget.invalidate()
			h.tui.requestRender()
			h.tui.renderNow()
			h.mouse(0, y, true)

			if (label === "+2 more") expect(h.screen().join("\n")).toContain("FIFTH MESSAGE")

			if (label === "Show fewer") expect(h.screen().join("\n")).not.toContain("FIFTH MESSAGE")

			if (label.startsWith("▸")) expect(h.screen()).toContain("│   FULL SECOND LINE")

			if (label.startsWith("▾")) expect(h.screen()).not.toContain("│   FULL SECOND LINE")
		}

		const y = h.row("▸ helper · steer")
		h.mouse(0, y)
		h.widget.setMessages([{ ...messages[0]!, key: "replacement" }, ...messages.slice(1)])
		h.tui.renderNow()
		h.mouse(0, y, true)
		expect(h.screen()).not.toContain("│   FULL SECOND LINE")
	} finally {
		h.close()
	}
})

test("native modifier/non-left/drag/release-only gestures do not expand or toggle the list", () => {
	const h = native()

	try {
		for (const label of ["▸ helper · steer", "+2 more"]) {
			for (const code of [1, 2, 4, 8, 16]) h.click(label, code)
			const y = h.row(label)
			h.mouse(0, y, true)
			h.mouse(4, y)
			h.mouse(0, y, true)
			h.mouse(0, y)
			h.mouse(32, y, false, 5)
			h.mouse(32, y, false, 1)
			h.mouse(0, y, true)
		}

		expect(h.screen()).not.toContain("│   FULL SECOND LINE")
		expect(h.screen().join("\n")).not.toContain("FIFTH MESSAGE")
		expect(h.tui.getFocusedComponent()).toBe(h.editor)
	} finally {
		h.close()
	}
})

test("native SGR heading, body, count and list-label drags retain text selection", () => {
	const h = native()

	try {
		if (!(h.tui instanceof TuiAltScreen)) throw new Error("Expected fullscreen host")

		for (const label of ["helper · steer", "Pair preview", "Messages ·", "+2 more"]) {
			h.tui.resetTextSelection()
			expect(h.tui.hasActiveSelection()).toBe(false)
			const y = h.row(label)
			h.mouse(0, y, false, 4)
			h.mouse(32, y, false, 15)
			h.mouse(0, y, true, 15)
			expect(h.tui.hasActiveSelection()).toBe(true)
			expect(h.screen()).not.toContain("│   FULL SECOND LINE")
			expect(h.screen().join("\n")).not.toContain("FIFTH MESSAGE")
		}

		h.tui.resetTextSelection()
		const heading = h.row("helper · steer")
		h.mouse(0, heading, false, 4)
		h.mouse(32, heading + 1, false, 16)
		h.mouse(0, heading + 1, true, 16)
		expect(h.tui.hasActiveSelection()).toBe(true)
		expect(h.tui.getFocusedComponent()).toBe(h.editor)
	} finally {
		h.close()
	}
})

test("native click reveals a width-truncated single-line body and survives resize", () => {
	const h = native()

	try {
		h.terminal.columns = 40
		h.widget.setMessages([{ ...messages[0]!, text: `BEGIN ${"word ".repeat(30)}TAIL` }])
		h.tui.renderNow()
		expect(h.screen().join("\n")).not.toContain("TAIL")
		h.click("▸ helper · steer")
		expect(h.screen().join("\n")).toContain("TAIL")
		h.terminal.columns = 60
		h.tui.renderNow()
		expect(h.screen().join("\n")).toContain("TAIL")
		h.click("▾ helper · steer")
		expect(h.screen().join("\n")).not.toContain("TAIL")
	} finally {
		h.close()
	}
})

test("native wheel reaches full giant body in a bounded viewport, pinned controls remain clickable", () => {
	const h = native()

	try {
		h.widget.setMessages([
			{ ...messages[0]!, text: Array.from({ length: 100 }, (_, i) => `body line ${i}`).join("\n") },
			...messages.slice(1),
		])
		h.tui.renderNow()
		h.click("▸ helper · steer")
		expect(h.widget.render(100).length).toBeLessThanOrEqual(12)
		expect(h.screen()).toContain("EDITOR")

		for (let i = 0; i < 110; i++) h.mouse(65, h.row("Messages ·") + 1)
		expect(h.screen()).toContain("│   body line 99")
		expect(h.screen()).toContain("  ▸ +2 more")
		h.click("↑ Messages")
		expect(h.screen()).toContain("│   body line 0")
		h.click("▾ helper · steer")
		expect(h.screen()).not.toContain("│   body line 0")
		h.click("+2 more")
		expect(h.screen().join("\n")).toContain("FIFTH MESSAGE")
		expect(h.tui.getFocusedComponent()).toBe(h.editor)
	} finally {
		h.close()
	}
})

test("updates preserve expansion by delivery key, remove handled rows, clear empty state and dispose", () => {
	const h = native()

	try {
		h.click("▸ helper · steer")
		h.click("+2 more")
		h.widget.setMessages(messages.map((message) => ({ ...message })))
		h.tui.renderNow()
		expect(h.screen()).toContain("│   FULL SECOND LINE")
		expect(h.lastPage().join("\n")).toContain("FIFTH MESSAGE")
		h.widget.setMessages([messages[0]!, ...messages.slice(2)])
		h.tui.renderNow()
		expect(h.screen()).toContain("│   FULL SECOND LINE")
		expect(h.screen().join("\n")).not.toContain("Human in the pair")
		h.widget.setMessages(messages.slice(1))
		h.widget.setMessages(messages)
		h.tui.renderNow()
		expect(h.screen()).not.toContain("│   FULL SECOND LINE")
		h.widget.setMessages([])
		expect(h.widget.render(100)).toEqual([])
		h.widget.setMessages(messages)
		expect(plain(h.widget.render(100))).toContain("  ▸ +2 more")
		h.widget.dispose()
		h.widget.setMessages(messages)
		expect(h.widget.render(100)).toEqual([])
	} finally {
		h.close()
	}
})

test("regular native TUI does not route mouse; presentation methods preserve focus", () => {
	const h = native(false)

	try {
		h.click("▸ helper · steer")
		expect(h.screen()).not.toContain("│   FULL SECOND LINE")
		expect(h.terminal.output.join("")).not.toContain("\x1b[?1000h")
		h.widget.toggleMessage("one")
		h.widget.setShowAll(true)
		h.tui.renderNow()
		expect(h.screen()).toContain("│   FULL SECOND LINE")
		expect(h.lastPage().join("\n")).toContain("FIFTH MESSAGE")
		expect(h.tui.getFocusedComponent()).toBe(h.editor)
	} finally {
		h.close()
	}
})

for (const initiallyExpanded of [false, true]) {
	test(`native expansion getter initially ${initiallyExpanded}, changes without message updates, and resets scroll`, () => {
		let expanded = initiallyExpanded
		const h = native(true, () => expanded)

		try {
			for (const state of [initiallyExpanded, !initiallyExpanded, initiallyExpanded]) {
				expanded = state
				h.tui.requestRender()
				h.tui.renderNow()
				expect(h.screen().includes("│   FULL SECOND LINE")).toBe(state)
				expect(h.lastPage().join("\n").includes("FIFTH MESSAGE")).toBe(state)
				expect(h.screen()).toContain(state ? "  ▾ Show fewer" : "  ▸ +2 more")
			}

			expanded = true
			h.widget.setMessages([
				{ ...messages[0]!, text: Array.from({ length: 100 }, (_, i) => `body line ${i}`).join("\n") },
				...messages.slice(1),
			])
			h.tui.renderNow()
			h.widget.scrollBy(500)
			h.tui.renderNow()
			expect(h.screen().join("\n")).toContain("FIFTH MESSAGE")
			expanded = false
			h.tui.renderNow()
			expect(h.screen().join("\n")).toContain("▸ helper · steer")
			expect(h.screen()).toContain("  ▸ +2 more")
			expanded = true
			h.tui.renderNow()
			expect(h.screen()).toContain("│   body line 0")
			expect(h.widget.render(100).length).toBeLessThanOrEqual(12)
		} finally {
			h.close()
		}
	})
}

test("unchanged global state preserves mouse choices; only new keys inherit expansion", () => {
	let expanded = true
	const h = native(true, () => expanded)

	try {
		h.click("▾ helper · steer")
		h.click("Show fewer")
		h.widget.invalidate()
		h.widget.setMessages(messages.map((message) => ({ ...message })))
		h.tui.renderNow()
		expect(h.screen()).not.toContain("│   FULL SECOND LINE")
		expect(h.screen()).toContain("  ▸ +2 more")

		const arrival: PendingMessage = {
			key: "new",
			pool: undefined,
			sender: "new",
			delivery: "steer",
			text: "Arrival\nNEW BODY",
		}

		h.widget.setMessages([messages[0]!, arrival, ...messages.slice(1)])
		h.tui.renderNow()
		expect(h.screen()).toContain("│   NEW BODY")
		expect(h.screen()).not.toContain("│   FULL SECOND LINE")
		expect(h.screen()).toContain("  ▸ +3 more")
		h.click("▾ new · steer")
		h.click("▸ helper · steer")
		h.tui.renderNow()
		expect(h.screen()).not.toContain("│   NEW BODY")
		expect(h.screen()).toContain("│   FULL SECOND LINE")
		expanded = false
		h.tui.renderNow()
		expect(h.screen()).not.toContain("│   FULL SECOND LINE")
		h.click("▸ helper · steer")
		h.widget.setMessages([messages[0]!, arrival, ...messages.slice(2)])
		h.tui.renderNow()
		expect(h.screen()).toContain("│   FULL SECOND LINE")
		expanded = true
		h.tui.renderNow()
		expect(h.screen()).toContain("│   FULL SECOND LINE")
		expect(h.screen()).toContain("│   NEW BODY")
		expect(h.screen()).toContain("  ▾ Show fewer")
		expect(h.tui.getFocusedComponent()).toBe(h.editor)
	} finally {
		h.close()
	}
})

test("empty renders observe global toggles and returning keys inherit the current state", () => {
	let expanded = false
	const h = native(true, () => expanded)

	try {
		for (const state of [true, true, false]) {
			h.widget.setMessages([])
			expanded = state
			expect(h.widget.render(100)).toEqual([])
			h.widget.setMessages(messages)
			h.tui.renderNow()
			expect(h.screen().includes("│   FULL SECOND LINE")).toBe(state)
			expect(h.lastPage().join("\n").includes("FIFTH MESSAGE")).toBe(state)
		}
	} finally {
		h.close()
	}
})

test("Unicode, tiny viewports and multiline bodies stay bounded and display-only", () => {
	const message: PendingMessage = {
		key: "multiline",
		pool: undefined,
		sender: "helper",
		delivery: "steer",
		text: "界🙂é\nnext line\nend" + "x".repeat(10000),
	}

	const original = JSON.stringify(message)
	let rows = 36

	const widget = new PendingWidget(
		() => palette(),
		() => {},
		() => rows,
	)

	widget.setMessages([message])

	for (const expanded of [false, true]) {
		if (expanded) widget.toggleMessage(message.key)

		for (rows of [1, 3, 6, 9, 36, 100]) {
			for (const width of [0, 1, 2, 3, 8, 20, 80, 200]) {
				const lines = widget.render(width)
				expect(lines.length).toBeLessThanOrEqual(Math.max(1, Math.min(12, Math.floor(rows / 3))))

				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
			}
		}
	}

	expect(JSON.stringify(message)).toBe(original)
	widget.dispose()
})

for (const appearance of ["dark", "light"]) {
	for (const colorMode of ["truecolor", "256color"] as const) {
		test(`pending expansion stays muted without card backgrounds (${appearance}, ${colorMode})`, () => {
			const theme = palette(appearance, colorMode)
			let expanded = false

			const widget = new PendingWidget(
				() => theme,
				() => {},
				() => 36,
				() => expanded,
				() => "regular",
			)

			const body = "first\n" + "long body\n".repeat(100) + "FINAL BODY\x1b[2J"
			widget.setMessages([{ key: "safe", pool: undefined, sender: "helper\x1b[31m", delivery: "followUp", text: body }])

			try {
				for (expanded of [false, true, false]) {
					const rows = widget.render(120)
					// oxlint-disable-next-line no-control-regex -- The pending rail must never paint a card background.
					expect(rows.join("\n")).not.toMatch(/\x1b\[(?:48;|4[0-7]m)/)
					expect(rows[0]?.trimEnd()).toBe(
						pendingText(theme, "warning", "    Messages · 1 pending · /session-messages pending"),
					)
					expect(rows.join("\n")).toContain(pendingText(theme, "accent", "helper\\u001b[31m"))
					expect(rows.every((row) => visibleWidth(row) === PENDING_WIDTH)).toBe(true)

					if (expanded) {
						expect(rows.length).toBeGreaterThan(100)
						expect(rows.join("\n")).toContain(theme.fg("dim", "FINAL BODY\\u001b[2J"))
					} else {
						expect(rows.length).toBeLessThanOrEqual(12)
						expect(plain(rows).join("\n")).not.toContain("FINAL BODY")
					}
				}
			} finally {
				widget.dispose()
			}
		})
	}
}

test("pending inline identities escape every newline control without changing the envelope", () => {
	const h = native()

	const message: PendingMessage = {
		key: "controls",
		pool: undefined,
		sender: "sender\n\r\v\f\u0085\u2028\u2029END",
		delivery: "steer",
		text: "FIRST\nSECOND\u2028THIRD",
	}

	const original = JSON.stringify(message)

	try {
		h.widget.setMessages([message])

		for (const expanded of [false, true]) {
			if (expanded) h.widget.toggleMessage(message.key)

			for (const width of [1, 8, 24, 80]) {
				const rows = plain(h.widget.render(width))

				for (const row of rows) expect(row).not.toMatch(/[\n\r\v\f\u0085\u2028\u2029]/)
			}
		}

		expect(JSON.stringify(message)).toBe(original)
	} finally {
		h.close()
	}
})

test("compact list has three previews and actual count; invalidate refreshes theme colors", () => {
	let theme = palette()

	const widget = new PendingWidget(
		() => theme,
		() => {},
		() => 36,
	)

	widget.setMessages(messages)
	const dark = widget.render(100)
	expect(dark.length).toBe(PENDING_PREVIEWS * 2 + 2)

	for (const appearance of ["dark", "light"]) {
		for (const mode of ["truecolor", "256color"] as const) {
			theme = palette(appearance, mode)
			widget.invalidate()
			const rows = widget.render(100)
			expect(rows[0]?.trimEnd()).toBe(
				pendingText(theme, "warning", "    Messages · 5 pending · /session-messages pending"),
			)
			expect(plain(rows)).toEqual(plain(dark))
		}
	}

	expect(widget.render(100)).not.toEqual(dark)
})

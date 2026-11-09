import { describe, expect, test } from "bun:test"
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui"
import { buildSafetySettings, createSafetySettingsComponent } from "./safety-settings"

describe("Pi Safety settings", () => {
	test("offers disabled-by-default protection", () => {
		expect(buildSafetySettings(false)).toMatchObject([
			{ id: "protection", label: "Seatbelt", currentValue: "disabled", values: ["disabled", "enabled"] },
		])
	})

	test("changes settings in place and opens a read-only policy view", () => {
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text }
		let closed = false
		const changes: boolean[] = []
		let renderRequests = 0

		const component = createSafetySettingsComponent(
			theme,
			new KeybindingsManager(TUI_KEYBINDINGS),
			() => {
				renderRequests += 1
			},
			() => {
				closed = true
			},
			false,
			[
				{
					number: 1,
					label: "/**",
					value: "read-only",
					summary: "Bash and built-ins · Read only",
					dsl: 'file shared read-only tree="/"',
				},
				{
					number: 2,
					label: "$HOME/.cache/**",
					value: "read-write",
					summary: "Bash and built-ins · Read and write",
					dsl: 'file shared read-write tree="/home/.cache"',
				},
			],
			(enabled) => {
				changes.push(enabled)
			},
		)

		component.handleInput("\r")
		expect(closed).toBe(false)
		component.handleInput("p")
		expect(component.render(120).join("\n")).toContain('DSL: file shared read-only tree="/"')

		for (const character of "cache") component.handleInput(character)
		expect(component.render(120).join("\n")).toContain('DSL: file shared read-write tree="/home/.cache"')
		component.handleInput("\r")
		expect(closed).toBe(false)
		component.handleInput("\x1b")
		expect(closed).toBe(false)
		component.handleInput("\x1b")
		expect(closed).toBe(false)
		component.handleInput("\x1b")
		expect(renderRequests).toBeGreaterThan(0)
		expect(changes).toEqual([true])
		expect(closed).toBe(true)
	})
})

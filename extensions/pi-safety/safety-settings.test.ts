import { describe, expect, test } from "bun:test"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getKeybindings } from "@earendil-works/pi-tui"
import { buildSafetySettings, showPiSafetySettings } from "./safety-settings"

describe("Pi Safety settings", () => {
	test("offers disabled-by-default protection and enabled-by-default checkpoints", () => {
		expect(buildSafetySettings(false, true)).toMatchObject([
			{ id: "protection", label: "Seatbelt", currentValue: "disabled", values: ["disabled", "enabled"] },
			{ id: "checkpoints", currentValue: "enabled", values: ["disabled", "enabled"] },
		])
	})

	test("changes settings in place and opens a read-only policy view", async () => {
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text }
		;(globalThis as Record<symbol, unknown>)[Symbol.for("@earendil-works/pi-coding-agent:theme")] = theme
		let closed = false
		let change: unknown
		const context = {
			mode: "tui",
			ui: {
				custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
					const component = await factory(
						{ requestRender() {} } as never,
						theme as never,
						getKeybindings() as never,
						() => {
							closed = true
						},
					)
					if (!component.handleInput) throw new Error("settings component does not accept input")
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
				},
			},
		} as unknown as ExtensionContext

		await showPiSafetySettings(
			context,
			false,
			true,
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
			(feature, enabled) => {
				change = { feature, enabled }
			},
		)
		expect(change).toEqual({ feature: "protection", enabled: true })
		expect(closed).toBe(true)
	})
})

import { describe, expect, test } from "bun:test"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { type SafetySettingsAction, buildSafetySettings, showPiSafetySettings } from "./safety-settings"

function settingsContext(action: SafetySettingsAction): ExtensionContext {
	return {
		mode: "tui",
		ui: { custom: async () => action },
	} as unknown as ExtensionContext
}

describe("Pi Safety settings", () => {
	test("offers disabled-by-default protection and enabled-by-default checkpoints", () => {
		expect(buildSafetySettings(false, true)).toMatchObject([
			{ id: "protection", currentValue: "disabled", values: ["disabled", "enabled"] },
			{ id: "checkpoints", currentValue: "enabled", values: ["disabled", "enabled"] },
		])
	})

	test("returns independent protection and checkpoint changes", async () => {
		const protection = { feature: "protection", enabled: true } as const
		const checkpoints = { feature: "checkpoints", enabled: false } as const
		expect(await showPiSafetySettings(settingsContext(protection), false, true, [])).toEqual(protection)
		expect(await showPiSafetySettings(settingsContext(checkpoints), true, true, [])).toEqual(checkpoints)
	})
})

import { describe, expect, test } from "bun:test"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { BashSandboxSession } from "./bash-sandbox-session"
import { buildBashSandboxSetting, showPiSafetySettings } from "./safety-settings"

function settingsContext(input: {
	readonly confirm: boolean
	readonly notifications: string[]
}): ExtensionContext {
	return {
		mode: "tui",
		ui: {
			custom: async () => "disable-bash-sandbox",
			confirm: async () => input.confirm,
			notify: (message: string) => input.notifications.push(message),
		},
	} as unknown as ExtensionContext
}

describe("Pi Safety settings", () => {
	test("offers a one-way session-scoped Seatbelt bypass", () => {
		const session = BashSandboxSession.create()
		expect(buildBashSandboxSetting(session)).toMatchObject({
			id: "bash-seatbelt",
			currentValue: "enabled",
			values: ["enabled", "disabled for this session"],
		})

		session.disableForSession()
		expect(buildBashSandboxSetting(session)).toMatchObject({
			currentValue: "disabled for this session",
			values: ["disabled for this session"],
		})
	})

	test("disables only after explicit confirmation", async () => {
		const notifications: string[] = []
		const session = BashSandboxSession.create()
		let disabled = false

		await showPiSafetySettings(
			settingsContext({ confirm: true, notifications }),
			session,
			async () => {
				await Promise.resolve()
				disabled = true
			},
			["checkpoint=not-started"],
		)

		expect(session.mode()).toBe("disabled-for-session")
		expect(disabled).toBe(true)
		expect(notifications).toEqual(["pi-safety: Bash Seatbelt disabled until /reload or a new Pi session"])
	})

	test("keeps Seatbelt enabled when confirmation is declined", async () => {
		const session = BashSandboxSession.create()
		await showPiSafetySettings(
			settingsContext({ confirm: false, notifications: [] }),
			session,
			() => {
				throw new Error("unexpected disable callback")
			},
			[],
		)
		expect(session.mode()).toBe("enabled")
	})
})

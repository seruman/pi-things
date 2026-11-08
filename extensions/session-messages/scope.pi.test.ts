import { expect, test } from "bun:test"
import {
	loadThemeFromPath,
	setThemeInstance,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
import { createSessionMessages } from "./index"
import { sdk, testDirectory } from "./fixtures/sdk"

for (const mode of ["rpc", "tui"] as const) {
	test(`footer tracks membership in ${mode}`, async () => {
		if (mode === "tui") {
			setThemeInstance(
				loadThemeFromPath(
					new URL(
						"../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json",
						import.meta.url,
					).pathname,
				),
			)
		}

		const root = testDirectory()
		const statuses: [string, string | undefined][] = []

		const h = await sdk({
			root,
			pool: false,
			mode,
			status: (key, text) => statuses.push([key, text]),
			extension: createSessionMessages({ root }),
		})

		const expected = (text: string) =>
			mode === "tui" ? h.session.extensionRunner.getUIContext().theme.fg("muted", text) : text

		expect(statuses).toEqual([["session-messages", expected("scope: private")]])

		for (const [command, text] of [
			["join private", "scope: pool/private"],
			["join review", "scope: pool/review"],
			["leave", "scope: private"],
		] as const) {
			await h.session.prompt(`/session-messages ${command}`)
			expect(statuses.at(-1)).toEqual(["session-messages", expected(text)])

			if (command === "join private") {
				const count = statuses.length
				await h.session.prompt("/session-messages join bad/name")
				expect(statuses).toHaveLength(count)
			}
		}

		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })
		expect(statuses.at(-1)).toEqual(["session-messages", undefined])
		expect(h.errors).toEqual([])
	})
}

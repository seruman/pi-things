import { expect, test } from "bun:test"
import { classified, customEntries, gate, harness } from "./fixtures/sdk-harness"
import { MODE_ENTRY } from "./state"

test.each(["rpc", "json", "print"] as const)("router settings explain the TUI requirement in %s mode", async (mode) => {
	const h = await harness({ enableRouter: false })
	await h.session.bindExtensions({ mode, uiContext: h.session.extensionRunner.getUIContext() })
	const branch = structuredClone(h.session.sessionManager.getBranch())
	const model = h.session.model
	const thinking = h.session.thinkingLevel
	await h.session.prompt("/router")
	expect(h.notifications.at(-1)).toContain("TUI")
	expect(h.settingsFrames).toEqual([])
	expect(h.session.sessionManager.getBranch()).toEqual(branch)
	expect(h.session.model).toEqual(model)
	expect(h.session.thinkingLevel).toBe(thinking)
	expect(h.dispatches).toEqual([])
	h.assertHealthy()
})

test.each([false, true])(
	"settings reject enabling or changing an active run's preset (enabled=%s)",
	async (enabled) => {
		const started = gate()
		const release = gate()

		const h = await harness({
			enableRouter: enabled,
			classify: async () => classified("standard"),
			steps: [{ started: started.open, wait: release.promise }],
			routers: ({ alternate }) => ({
				alternate: {
					tiers: {
						standard: { provider: alternate, model: "middle", thinking: "medium" },
						strong: { provider: alternate, model: "big", thinking: "high" },
					},
				},
			}),
		})

		const run = h.session.prompt("A request still being processed")

		try {
			await started.promise
			const mode = structuredClone(customEntries(h.session, MODE_ENTRY))
			const model = h.session.model
			const thinking = h.session.thinkingLevel
			await h.configureRouter(enabled ? { preset: "alternate" } : { enabled: true })
			expect(h.notifications.at(-1)).toContain("current run")
			expect(customEntries(h.session, MODE_ENTRY)).toEqual(mode)
			expect(h.session.model).toEqual(model)
			expect(h.session.thinkingLevel).toBe(thinking)
			const panel = await h.openRouter()
			expect(panel.frame()).toMatch(enabled ? /Enabled\s+yes/ : /Enabled\s+no/)
			expect(panel.frame()).toMatch(/Preset\s+test\b/)
			panel.press("\x1b")
			await panel.result
		} finally {
			release.open()
			await run
		}

		expect(h.dispatches).toHaveLength(1)
		h.assertHealthy()
	},
)

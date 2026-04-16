import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { getSettingsListTheme, isToolCallEventType } from "@mariozechner/pi-coding-agent"
import { Container, type SettingItem, SettingsList, Text } from "@mariozechner/pi-tui"
import { DEFAULT_CAPABILITIES, analyseShellCommand } from "./shell-capabilities"

export default function (pi: ExtensionAPI) {
	const sessionApproved = new Set<string>()

	pi.on("session_start", async () => {
		sessionApproved.clear()
	})

	pi.on("tool_call", async (event, ctx) => {
		if (!ctx.hasUI) return
		if (!isToolCallEventType("bash", event)) return

		const analysis = analyseShellCommand(event.input.command)

		if (analysis.issues.length > 0) {
			ctx.ui.notify(`shell-leash: ${analysis.issues.length} parse issue(s), command not fully analysed`, "warning")
		}

		if (analysis.hits.length === 0) return

		const blocked = analysis.hits.filter((hit) => !sessionApproved.has(hit.capability))
		if (blocked.length === 0) return

		const capabilities = [...new Set(blocked.map((hit) => hit.capability))]
		const descriptions = blocked.map((hit) => `  ${hit.capability}: ${hit.command}`)
		const sessionOptions = capabilities.map((cap) => `Allow ${cap} for session`)

		const options = ["Allow once", ...sessionOptions, "Deny"]
		const prompt = `shell-leash\n${descriptions.join("\n")}`
		const choice = await ctx.ui.select(prompt, options)

		if (!choice || choice === "Deny") {
			return { block: true, reason: `Blocked: ${capabilities.join(", ")}` }
		}

		if (choice !== "Allow once") {
			const approved = sessionOptions.indexOf(choice)
			if (approved >= 0) sessionApproved.add(capabilities[approved])
		}
	})

	pi.registerCommand("shell-leash", {
		description: "Manage shell-leash approvals for this session",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items: SettingItem[] = DEFAULT_CAPABILITIES.map((cap) => ({
					id: cap.id,
					label: cap.id,
					description: cap.description,
					currentValue: sessionApproved.has(cap.id) ? "allowed" : "guarded",
					values: ["guarded", "allowed"],
				}))

				const container = new Container()
				container.addChild(new Text(theme.fg("accent", theme.bold("shell-leash")), 0, 0))

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 18),
					getSettingsListTheme(),
					(id, newValue) => {
						if (newValue === "allowed") {
							sessionApproved.add(id)
						} else {
							sessionApproved.delete(id)
						}
					},
					() => done(undefined),
				)

				container.addChild(settingsList)

				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						settingsList.handleInput?.(data)
						tui.requestRender()
					},
				}
			})
		},
	})
}

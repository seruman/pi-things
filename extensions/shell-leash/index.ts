import { fileURLToPath } from "node:url"
import { getSettingsListTheme, isToolCallEventType } from "@earendil-works/pi-coding-agent"
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui"
import { registerChildPolicy } from "./child-policy"
import type { ShellLeashHost } from "./contracts"
import { stopDeniedRun } from "./denial"
import { childFlags, decision, readPolicy } from "./policy"
import { DEFAULT_CAPABILITIES, analyseShellCommand } from "./shell-capabilities"

export default function (pi: ShellLeashHost) {
	const sessionApproved = new Set<string>()

	pi.registerFlag("shell-leash-allow", {
		type: "string",
		description: "Comma-separated shell-leash capabilities to allow without prompting",
	})
	pi.registerFlag("shell-leash-deny", {
		type: "string",
		description: "Comma-separated shell-leash capabilities to deny (wins over allow)",
	})
	pi.registerFlag("shell-leash-default", {
		type: "string",
		default: "ask",
		description: "Other guarded capabilities: ask or deny (default: ask)",
	})

	registerChildPolicy(pi.events, () => [
		// Keep the guard loaded even when the child's cwd has different project extensions.
		"--extension",
		fileURLToPath(import.meta.url),
		...childFlags(readPolicy(pi.getFlag), sessionApproved),
	])

	pi.on("session_start", () => {
		sessionApproved.clear()
		readPolicy(pi.getFlag)
	})

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return

		try {
			// Validate on use too: lifecycle handler errors alone do not stop Pi's agent loop.
			const policy = readPolicy(pi.getFlag)
			const analysis = analyseShellCommand(event.input.command)

			if (analysis.issues.length > 0 && ctx.hasUI) {
				ctx.ui.notify(`shell-leash: ${analysis.issues.length} parse issue(s), command not fully analysed`, "warning")
			}

			if (analysis.hits.length === 0) return

			const denied = analysis.hits.filter((hit) => decision(policy, sessionApproved, hit.capability) === "deny")

			if (denied.length > 0) {
				return stopDeniedRun(
					pi,
					ctx,
					`shell-leash policy denies: ${[...new Set(denied.map((hit) => hit.capability))].join(", ")}.`,
				)
			}

			const blocked = analysis.hits.filter((hit) => decision(policy, sessionApproved, hit.capability) === "ask")

			if (blocked.length === 0) return

			const capabilities = [...new Set(blocked.map((hit) => hit.capability))]

			if (!ctx.hasUI) {
				return stopDeniedRun(
					pi,
					ctx,
					`shell-leash requires approval for: ${capabilities.join(", ")}, but no UI is available.`,
				)
			}

			const descriptions = blocked.map((hit) => `  ${hit.capability}: ${hit.command}`)
			const sessionOptions = capabilities.map((cap) => `Allow ${cap} for session`)

			const options = ["Allow once", ...sessionOptions, "Deny"]
			const prompt = `shell-leash\n${descriptions.join("\n")}`
			const choice = await ctx.ui.select(prompt, options)

			if (!choice || choice === "Deny") {
				return stopDeniedRun(
					pi,
					ctx,
					`shell-leash: the user denied or dismissed approval for: ${capabilities.join(", ")}.`,
				)
			}

			if (choice !== "Allow once") {
				const approved = sessionOptions.indexOf(choice)

				if (approved >= 0) sessionApproved.add(capabilities[approved])
			}
		} catch (error) {
			return stopDeniedRun(
				pi,
				ctx,
				`shell-leash could not approve the command: ${error instanceof Error ? error.message : String(error)}.`,
			)
		}
	})

	pi.registerCommand("shell-leash", {
		description: "Manage shell-leash approvals for this session",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return

			if (ctx.mode !== "tui") {
				ctx.ui.notify("/shell-leash requires TUI mode", "error")

				return
			}

			const policy = readPolicy(pi.getFlag)
			const labels = { ask: "guarded", allow: "allowed", deny: "denied" }
			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items: SettingItem[] = DEFAULT_CAPABILITIES.map((cap) => {
					const base = decision(policy, new Set(), cap.id)

					return {
						id: cap.id,
						label: cap.id,
						description: base === "ask" ? cap.description : `${cap.description} (fixed by CLI policy)`,
						currentValue: labels[decision(policy, sessionApproved, cap.id)],
						values: base === "ask" ? ["guarded", "allowed"] : [labels[base]],
					}
				})

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

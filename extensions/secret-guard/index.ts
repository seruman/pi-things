import {
	DynamicBorder,
	type ExtensionAPI,
	getSettingsListTheme,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent"
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui"
import { type SecretGuardConfig, loadSecretGuardConfig, matchProtectedRead } from "./guard"

type Mode = "block" | "ask" | "audit" | "off"

const MODES: Mode[] = ["block", "ask", "audit", "off"]

function isMode(value: string): value is Mode {
	return MODES.includes(value as Mode)
}

function modeFromFlag(value: boolean | string | undefined): Mode {
	if (value === false) return "off"
	if (value === true || value === undefined) return "block"
	if (value === "ask" || value === "audit" || value === "off" || value === "block") return value
	return "block"
}

function formatMatch(path: string, matchedBy: string[]) {
	const patterns = matchedBy.length > 0 ? ` (${matchedBy.join(", ")})` : ""
	return `${path}${patterns}`
}

function filesValue(files: string[]) {
	return files.length === 0 ? "none" : String(files.length)
}

function filesDescription(files: string[]) {
	return files.length === 0 ? "No protect files loaded" : files.join("\n")
}

export default function (pi: ExtensionAPI) {
	let config: SecretGuardConfig | undefined
	let modeOverride: Mode | undefined

	pi.registerFlag("secret-guard", {
		type: "string",
		default: "block",
		description: "Guard reads of protected files: block, ask, audit, or off",
	})

	pi.on("session_start", async (_event, ctx) => {
		config = loadSecretGuardConfig(ctx.cwd)
	})

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("read", event)) return

		const mode = modeOverride ?? modeFromFlag(pi.getFlag("secret-guard"))
		if (mode === "off") return

		const currentConfig = config ?? loadSecretGuardConfig(ctx.cwd)
		config = currentConfig

		const match = matchProtectedRead(currentConfig, event.input.path)
		if (!match.blocked) return

		const message = `secret-guard: blocked read ${formatMatch(match.path, match.matchedBy)}`
		if (mode === "audit") {
			if (ctx.hasUI) ctx.ui.notify(message, "warning")
			return
		}

		if (mode === "ask" && ctx.hasUI) {
			const allow = await ctx.ui.confirm("secret-guard", `${message}\n\nAllow this read once?`)
			if (allow) return
		}

		if (ctx.hasUI) ctx.ui.notify(message, "warning")
		return { block: true, reason: message }
	})

	pi.registerCommand("secret-guard", {
		description: "Configure secret-guard for this session",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return

			const currentConfig = config ?? loadSecretGuardConfig(ctx.cwd)
			config = currentConfig

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const container = new Container()

				const items: SettingItem[] = [
					{
						id: "mode",
						label: "Mode",
						description: "",
						currentValue: modeOverride ?? modeFromFlag(pi.getFlag("secret-guard")),
						values: [...MODES],
					},
					{
						id: "protect-files",
						label: "Protect files",
						description: filesDescription(currentConfig.protectFiles),
						currentValue: filesValue(currentConfig.protectFiles),
					},
					{
						id: "project",
						label: "Project",
						description: currentConfig.projectRoot,
						currentValue: currentConfig.projectRoot,
					},
				]

				const settingsList = new SettingsList(
					items,
					5,
					getSettingsListTheme(),
					(id, newValue) => {
						if (id === "mode" && isMode(newValue)) modeOverride = newValue
					},
					() => done(undefined),
				)

				container.addChild(new DynamicBorder(theme.fg.bind(theme, "muted")))
				container.addChild(settingsList)
				container.addChild(new DynamicBorder(theme.fg.bind(theme, "muted")))

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

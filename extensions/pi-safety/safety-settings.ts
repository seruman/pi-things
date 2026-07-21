import { type ExtensionContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent"
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui"
import type { BashSandboxSession } from "./bash-sandbox-session"

const ENABLED = "enabled"
const DISABLED = "disabled for this session"
type SettingsAction = "disable-bash-sandbox" | undefined

export function buildBashSandboxSetting(session: BashSandboxSession): SettingItem {
	const enabled = session.isEnabled()
	return {
		id: "bash-seatbelt",
		label: "Bash Seatbelt",
		currentValue: enabled ? ENABLED : DISABLED,
		values: enabled ? [ENABLED, DISABLED] : [DISABLED],
		description: enabled
			? "Sandbox model-issued Bash with macOS Seatbelt. Disabling lasts until /reload or a new Pi session."
			: "Model-issued Bash is unsandboxed. Use /reload or start a new Pi session to restore Seatbelt safely.",
	}
}

export async function showPiSafetySettings(
	context: ExtensionContext,
	session: BashSandboxSession,
	onDisabled: () => void | Promise<void>,
	statusLines: readonly string[],
): Promise<void> {
	if (context.mode !== "tui") {
		context.ui.notify("/pi-safety requires TUI mode", "error")
		return
	}

	const action = await context.ui.custom<SettingsAction>((tui, theme, _keybindings, done) => {
		const container = new Container()
		container.addChild(new Text(theme.fg("accent", theme.bold("Pi Safety — session settings")), 1, 0))
		container.addChild(new Text(theme.fg("dim", statusLines.join("\n")), 1, 1))
		const settings = new SettingsList(
			[buildBashSandboxSetting(session)],
			3,
			getSettingsListTheme(),
			(id, value) => {
				if (id === "bash-seatbelt" && value === DISABLED) done("disable-bash-sandbox")
			},
			() => done(undefined),
		)
		container.addChild(settings)
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				settings.handleInput(data)
				tui.requestRender()
			},
		}
	})
	if (action !== "disable-bash-sandbox" || !session.isEnabled()) return

	const confirmed = await context.ui.confirm(
		"Disable Bash Seatbelt for this session?",
		[
			"Model-issued Bash will run with your full user permissions until /reload or a new Pi session.",
			"It may access credentials and change files outside the project.",
			"Checkpoints, built-in tool guards, and the standalone Shell Leash remain active.",
		].join("\n\n"),
	)
	if (!confirmed) return

	session.disableForSession()
	await onDisabled()
	context.ui.notify("pi-safety: Bash Seatbelt disabled until /reload or a new Pi session", "warning")
}

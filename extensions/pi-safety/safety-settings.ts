import { type ExtensionContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent"
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui"

const ENABLED = "enabled"
const DISABLED = "disabled"

export type SafetyFeature = "protection" | "checkpoints"

export function buildSafetySettings(protection: boolean, checkpoints: boolean): SettingItem[] {
	return [
		{
			id: "protection",
			label: "Seatbelt",
			currentValue: protection ? ENABLED : DISABLED,
			values: [DISABLED, ENABLED],
			description: "Toggle Seatbelt for model-issued Bash and path guards for built-in read, write, and edit tools.",
		},
		{
			id: "checkpoints",
			label: "APFS checkpoints",
			currentValue: checkpoints ? ENABLED : DISABLED,
			values: [DISABLED, ENABLED],
			description: "Create one lazy project checkpoint per mutating agent turn, independently of Seatbelt.",
		},
	]
}

export async function showPiSafetySettings(
	context: ExtensionContext,
	protection: boolean,
	checkpoints: boolean,
	onChange: (feature: SafetyFeature, enabled: boolean) => void,
): Promise<void> {
	if (context.mode !== "tui") {
		context.ui.notify("/pi-safety requires TUI mode", "error")
		return
	}

	await context.ui.custom((tui, theme, _keybindings, done) => {
		const container = new Container()
		container.addChild(new Text(theme.fg("accent", theme.bold("Pi Safety — session settings")), 1, 0))
		const settings = new SettingsList(
			buildSafetySettings(protection, checkpoints),
			3,
			getSettingsListTheme(),
			(id, value) => {
				if (id !== "protection" && id !== "checkpoints") return
				onChange(id, value === ENABLED)
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
}

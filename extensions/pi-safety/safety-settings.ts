import { type ExtensionContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent"
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui"

const ENABLED = "enabled"
const DISABLED = "disabled"

export type SafetyFeature = "protection" | "checkpoints"
export interface SafetySettingsAction {
	readonly feature: SafetyFeature
	readonly enabled: boolean
}

export function buildSafetySettings(protection: boolean, checkpoints: boolean): SettingItem[] {
	return [
		{
			id: "protection",
			label: "Filesystem protection",
			currentValue: protection ? ENABLED : DISABLED,
			values: [DISABLED, ENABLED],
			description: "Toggle Seatbelt for model-issued Bash and path guards for built-in read, write, and edit tools.",
		},
		{
			id: "checkpoints",
			label: "APFS checkpoints",
			currentValue: checkpoints ? ENABLED : DISABLED,
			values: [DISABLED, ENABLED],
			description:
				"Create one lazy project checkpoint per mutating agent turn, independently of filesystem protection.",
		},
	]
}

export async function showPiSafetySettings(
	context: ExtensionContext,
	protection: boolean,
	checkpoints: boolean,
	statusLines: readonly string[],
): Promise<SafetySettingsAction | undefined> {
	if (context.mode !== "tui") {
		context.ui.notify("/pi-safety requires TUI mode", "error")
		return undefined
	}

	return context.ui.custom<SafetySettingsAction | undefined>((tui, theme, _keybindings, done) => {
		const container = new Container()
		container.addChild(new Text(theme.fg("accent", theme.bold("Pi Safety — session settings")), 1, 0))
		container.addChild(new Text(theme.fg("dim", statusLines.join("\n")), 1, 1))
		const settings = new SettingsList(
			buildSafetySettings(protection, checkpoints),
			3,
			getSettingsListTheme(),
			(id, value) => {
				if (id === "protection" || id === "checkpoints") done({ feature: id, enabled: value === ENABLED })
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

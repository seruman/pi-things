import { type ExtensionContext, getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent"
import { Container, SelectList, SettingsList, Text } from "@earendil-works/pi-tui"

export interface RouterSettings {
	enabled: boolean
	preset: string
}

export async function showRouterSettings(
	ctx: Pick<ExtensionContext, "ui">,
	presets: string[],
	read: () => RouterSettings,
	apply: (settings: RouterSettings) => Promise<void>,
) {
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		let current = read()
		let busy = false
		let closing = false
		const view = new Container()
		const progress = new Text("", 1, 0)
		view.addChild(new Text(theme.fg("accent", theme.bold("Router")), 1, 0))

		async function change(id: string, value: string) {
			busy = true
			progress.setText(theme.fg("dim", "Applying change…"))
			tui.requestRender()

			try {
				await apply(id === "enabled" ? { ...current, enabled: value === "yes" } : { ...current, preset: value })
			} catch (error) {
				ctx.ui.notify(`model-router: ${error instanceof Error ? error.message : String(error)}`, "error")
			} finally {
				current = read()
				settings.updateValue("enabled", current.enabled ? "yes" : "no")
				settings.updateValue("preset", current.preset)
				progress.setText("")
				busy = false

				if (closing) done(undefined)
				tui.requestRender()
			}
		}

		const settings = new SettingsList(
			[
				{
					id: "enabled",
					label: "Enabled",
					currentValue: current.enabled ? "yes" : "no",
					values: ["no", "yes"],
					description: "Let the router select the model and thinking level for this session branch.",
				},
				{
					id: "preset",
					label: "Preset",
					currentValue: current.preset,
					description: "Choose an existing preset. Changing it while disabled does not enable routing.",
					submenu: (value, finish) => {
						const list = new SelectList(
							presets.map((preset) => ({ value: preset, label: preset })),
							10,
							getSelectListTheme(),
						)

						list.setSelectedIndex(presets.indexOf(value))
						list.onSelect = (item) => finish(item.value)
						list.onCancel = () => finish()

						return list
					},
				},
			],
			2,
			getSettingsListTheme(),
			(id, value) => void change(id, value),
			() => done(undefined),
		)

		view.addChild(settings)
		view.addChild(progress)

		return {
			render: (width) => view.render(width),
			invalidate: () => view.invalidate(),
			handleInput: (data) => {
				if (busy) {
					if (keybindings.matches(data, "tui.select.cancel")) closing = true
				} else {
					settings.handleInput(data)
				}

				tui.requestRender()
			},
		}
	})
}

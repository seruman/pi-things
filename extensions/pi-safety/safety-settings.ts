import {
	type ExtensionContext,
	type Theme,
	getSelectListTheme,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent"
import {
	Container,
	Input,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Text,
	fuzzyFilter,
} from "@earendil-works/pi-tui"
import type { PolicyDisplayEntry } from "./policy-description"

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

function formatPolicyDetail(entry: PolicyDisplayEntry | undefined, theme: Theme): string {
	return entry ? `Meaning: ${entry.summary}\n${theme.fg("dim", `DSL: ${entry.dsl}`)}` : "No matching Seatbelt rules"
}

export async function showPiSafetySettings(
	context: ExtensionContext,
	protection: boolean,
	checkpoints: boolean,
	policy: readonly PolicyDisplayEntry[],
	onChange: (feature: SafetyFeature, enabled: boolean) => void,
): Promise<void> {
	if (context.mode !== "tui") {
		context.ui.notify("/pi-safety requires TUI mode", "error")
		return
	}

	await context.ui.custom((tui, theme, keybindings, done) => {
		const settingsView = new Container()
		settingsView.addChild(new Text(theme.fg("accent", theme.bold("Pi Safety — session settings")), 1, 0))
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
		settingsView.addChild(settings)
		settingsView.addChild(new Text(theme.fg("dim", "p view Seatbelt ACL"), 1, 0))

		const policyByNumber = new Map(policy.map((entry) => [String(entry.number), entry]))
		const policyItems: SelectItem[] = policy.map((entry) => ({
			value: String(entry.number),
			label: `#${entry.number} ${entry.label}`,
			description: entry.value,
		}))
		const policyTitle = new Text(
			theme.fg("accent", theme.bold("Seatbelt ACL — # is evaluation order; later matches override earlier ones")),
			1,
			0,
		)
		const searchLabel = new Text(theme.fg("dim", "Search:"), 1, 0)
		const search = new Input()
		const policyDetail = new Text(formatPolicyDetail(policy[0], theme), 1, 1)
		const noPolicyMatches = new Text(theme.fg("dim", "No matching Seatbelt rules"), 1, 0)
		const policyHint = new Text(theme.fg("dim", "Type to search · ↑↓ navigate · Esc clear/back"), 1, 0)
		let policyList: SelectList
		let policyItemCount = policyItems.length
		const setPolicyItems = (items: SelectItem[]) => {
			policyItemCount = items.length
			policyList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme())
			policyList.onSelectionChange = (item) =>
				policyDetail.setText(formatPolicyDetail(policyByNumber.get(item.value), theme))
			policyDetail.setText(formatPolicyDetail(policyByNumber.get(items[0]?.value ?? ""), theme))
		}
		setPolicyItems(policyItems)
		const applyPolicySearch = () => {
			const query = search.getValue()
			setPolicyItems(
				fuzzyFilter(policyItems, query, (item) => {
					const entry = policyByNumber.get(item.value)
					return `${item.label} ${item.description ?? ""} ${entry?.summary ?? ""} ${entry?.dsl ?? ""}`
				}),
			)
		}
		const policyView = {
			render: (width: number) => [
				...policyTitle.render(width),
				...searchLabel.render(width),
				...search.render(width),
				...(policyItemCount ? policyList : noPolicyMatches).render(width),
				...policyDetail.render(width),
				...policyHint.render(width),
			],
			invalidate: () => {
				policyTitle.invalidate()
				searchLabel.invalidate()
				search.invalidate()
				policyList.invalidate()
				noPolicyMatches.invalidate()
				policyDetail.invalidate()
				policyHint.invalidate()
			},
		}

		let showingPolicy = false
		return {
			render: (width: number) => (showingPolicy ? policyView : settingsView).render(width),
			invalidate: () => {
				settingsView.invalidate()
				policyView.invalidate()
			},
			handleInput: (data: string) => {
				if (!showingPolicy && data === "p") {
					showingPolicy = true
					search.focused = true
				} else if (!showingPolicy) {
					settings.handleInput(data)
				} else if (keybindings.matches(data, "tui.select.cancel")) {
					if (search.getValue()) {
						search.setValue("")
						applyPolicySearch()
					} else {
						showingPolicy = false
						search.focused = false
					}
				} else if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down")) {
					policyList.handleInput(data)
				} else if (!keybindings.matches(data, "tui.select.confirm")) {
					search.handleInput(data)
					applyPolicySearch()
				}
				tui.requestRender()
			},
		}
	})
}

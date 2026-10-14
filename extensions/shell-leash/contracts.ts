import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent"

export interface ShellLeashContext extends Pick<ExtensionContext, "hasUI" | "mode" | "abort"> {
	ui: Pick<ExtensionContext["ui"], "notify" | "select" | "custom">
}

export interface ShellLeashHandlers {
	session_start: () => void
	tool_call: (event: ToolCallEvent, ctx: ShellLeashContext) => Promise<ToolCallEventResult | undefined>
}

export interface ShellLeashHost extends Pick<ExtensionAPI, "events" | "registerFlag" | "getFlag" | "appendEntry"> {
	on<Key extends keyof ShellLeashHandlers>(event: Key, handler: ShellLeashHandlers[Key]): void
	registerCommand(
		name: string,
		command: { description: string; handler: (args: string, ctx: ShellLeashContext) => Promise<void> },
	): void
}

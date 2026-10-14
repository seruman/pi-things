import { type EventBus, type ExtensionAPI, type ToolCallEvent, createEventBus } from "@earendil-works/pi-coding-agent"
import type { ShellLeashContext, ShellLeashHandlers, ShellLeashHost } from "./contracts"
import shellLeash from "./index"

// Compile-time check that the narrowed host remains compatible with Pi's real extension API.
const extension: (pi: ExtensionAPI) => void = shellLeash

void extension

type Handlers = { [Key in keyof ShellLeashHandlers]: Set<ShellLeashHandlers[Key]> }

export function shellLeashHost(flags: Record<string, string> = {}, events: EventBus = createEventBus()) {
	const handlers: Handlers = {
		session_start: new Set(),
		tool_call: new Set(),
	}

	const values = new Map<string, boolean | string>(Object.entries(flags))
	const commands = new Map<string, Parameters<ShellLeashHost["registerCommand"]>[1]>()
	const prompts: { title: string; options: string[] }[] = []
	const choices: (string | undefined)[] = []
	const abort = new AbortController()
	const notifications: string[] = []
	const entries: { customType: string; data: unknown }[] = []

	const ctx: ShellLeashContext = {
		hasUI: true,
		mode: "tui",
		abort: () => abort.abort(),
		ui: {
			notify(message) {
				notifications.push(message)
			},
			async select(title, options) {
				prompts.push({ title, options })

				if (choices.length === 0) throw new Error("Unexpected approval prompt")

				return choices.shift()
			},
			async custom() {
				throw new Error("Unexpected custom UI")
			},
		},
	}

	shellLeash({
		events,
		appendEntry(customType, data) {
			entries.push({ customType, data })
		},
		registerFlag(name, options) {
			if (!values.has(name) && options.default !== undefined) values.set(name, options.default)
		},
		getFlag: (name) => values.get(name),
		on(event, handler) {
			handlers[event].add(handler)
		},
		registerCommand(name, command) {
			commands.set(name, command)
		},
	})

	return {
		events,
		ctx,
		signal: abort.signal,
		notifications,
		entries,
		prompts,
		choices,
		values,
		commands,
		start() {
			for (const handler of handlers.session_start) handler()
		},
		async tool(event: ToolCallEvent) {
			for (const handler of handlers.tool_call) {
				const result = await handler(event, ctx)

				if (result) return result
			}
		},
		async bash(command: string) {
			return this.tool({ type: "tool_call", toolCallId: "test", toolName: "bash", input: { command } })
		},
	}
}

export function policyFlags(args: string[]) {
	const flags: Record<string, string> = {}

	for (let i = 0; i < args.length; i += 2) {
		if (args[i].startsWith("--shell-leash-")) flags[args[i].slice(2)] = args[i + 1]
	}

	return flags
}

import type { JsonValue, Static, TSchema } from "@earendil-works/pi-ai"
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	ExtensionWidgetOptions,
	SessionShutdownEvent,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent"

export interface LifecycleEvents {
	session_start: { type: "session_start" }
	session_shutdown: SessionShutdownEvent
	agent_start: { type: "agent_start" }
	agent_settled: { type: "agent_settled" }
}

export type LifecycleHandler<Event, Context> = (event: Event, ctx: Context) => void | Promise<void>

export interface Lifecycle<Context> {
	on<Key extends keyof LifecycleEvents>(
		event: Key,
		handler: LifecycleHandler<LifecycleEvents[Key], Context>,
	): () => void
}

export interface ParentContext extends Pick<ExtensionContext, "cwd" | "hasUI"> {
	model?: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">
	ui: {
		theme: Pick<ExtensionContext["ui"]["theme"], "fg">
		notify: ExtensionContext["ui"]["notify"]
		custom: ExtensionContext["ui"]["custom"]
		setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void
	}
}

export interface BridgeContext extends Pick<ExtensionContext, "isIdle"> {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getSessionFile">
}

export interface BridgeHost extends Lifecycle<BridgeContext>, Pick<ExtensionAPI, "setSessionName"> {
	sendUserMessage(message: string, options?: { deliverAs: "steer" | "followUp" }): void
}

export type SubagentTool<Params extends TSchema, Result extends JsonValue> = Omit<
	ToolDefinition<Params, Result>,
	"execute"
> & {
	execute(
		id: string,
		params: Static<Params>,
		signal: AbortSignal | undefined,
		update: AgentToolUpdateCallback<Result> | undefined,
		ctx: ParentContext,
	): Promise<AgentToolResult<Result>>
}

export interface ParentHost extends Lifecycle<ParentContext>, Pick<ExtensionAPI, "exec" | "getThinkingLevel"> {
	registerCommand(
		name: string,
		command: {
			description: string
			handler(args: string, ctx: ParentContext): Promise<void>
		},
	): void
	registerTool<Params extends TSchema, Result extends JsonValue>(tool: SubagentTool<Params, Result>): void
}

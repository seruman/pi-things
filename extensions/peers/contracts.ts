import type { JsonValue, Static, TSchema } from "@earendil-works/pi-ai"
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
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

export interface PeersContext extends Pick<ExtensionContext, "cwd" | "hasUI" | "isIdle"> {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getSessionFile" | "getEntries">
	ui: { notify: ExtensionContext["ui"]["notify"] }
}

export type PeerTool<Params extends TSchema, Result extends JsonValue> = Omit<
	ToolDefinition<Params, Result>,
	"execute"
> & {
	execute(
		id: string,
		params: Static<Params>,
		signal: AbortSignal | undefined,
		update: AgentToolUpdateCallback<Result> | undefined,
		ctx: PeersContext,
	): Promise<AgentToolResult<Result>>
}

export interface PeersHost
	extends
		Lifecycle<PeersContext>,
		Pick<
			ExtensionAPI,
			"exec" | "events" | "appendEntry" | "getSessionName" | "sendMessage" | "registerMessageRenderer"
		> {
	registerTool<Params extends TSchema, Result extends JsonValue>(tool: PeerTool<Params, Result>): void
}

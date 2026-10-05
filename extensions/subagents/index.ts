import { realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { type Api, Type } from "@earendil-works/pi-ai"
import {
	type AgentSession,
	type ExtensionAPI,
	ProjectTrustStore,
	SessionManager,
	SettingsManager,
	createAgentSessionFromServices,
	createAgentSessionServices,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	defineTool,
	getAgentDir,
} from "@earendil-works/pi-coding-agent"
import { assertConfiguredExtensionsExist } from "./resources"
import { childUsage } from "./usage"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const parameters = Type.Object({
	prompt: Type.String({ minLength: 1 }),
	cwd: Type.Optional(Type.String()),
	model: Type.Optional(
		Type.String({ description: "Exact provider/model ID; defaults to the parent's selected model." }),
	),
	thinkingLevel: Type.Optional(
		Type.Union([
			Type.Literal("off"),
			Type.Literal("minimal"),
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
			Type.Literal("xhigh"),
			Type.Literal("max"),
		]),
	),
	tools: Type.Optional(Type.Union([Type.Literal("readonly"), Type.Array(Type.String())])),
	excludeTools: Type.Optional(Type.Array(Type.String())),
	noTools: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("builtin")])),
})
const modelSchema = Type.Object({ provider: Type.String(), id: Type.String() })
const outputSchema = Type.Object({
	status: Type.Union([Type.Literal("success"), Type.Literal("error"), Type.Literal("aborted")]),
	answer: Type.String(),
	sessionId: Type.Optional(Type.String()),
	model: Type.Optional(modelSchema),
	cwd: Type.String(),
	usage: Type.Object({
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		totalTokens: Type.Number(),
		reasoning: Type.Optional(Type.Number()),
		cacheWrite1h: Type.Optional(Type.Number()),
		cost: Type.Object({
			input: Type.Number(),
			output: Type.Number(),
			cacheRead: Type.Number(),
			cacheWrite: Type.Number(),
			total: Type.Number(),
		}),
	}),
	error: Type.Optional(Type.String()),
})

export function createSubagentsExtension(options: { createServices?: typeof createAgentSessionServices } = {}) {
	return (pi: ExtensionAPI) => {
		const workers = new Set<{ abort: () => void; done: Promise<void> }>()
		let stopping = false
		pi.on("session_shutdown", async () => {
			stopping = true
			const pending = [...workers]
			for (const worker of pending) worker.abort()
			await Promise.allSettled(pending.map((worker) => worker.done))
		})
		pi.registerTool(
			defineTool({
				name: "spawn_agent",
				label: "Spawn agent",
				description:
					"Run an independent ephemeral Pi child session. Children cannot call codemode or spawn_agent. readonly means exactly read/grep/find/ls, not an OS sandbox.",
				exposure: "codemode",
				parameters,
				outputSchema,
				async execute(_id, params, signal, _onUpdate, ctx) {
					const parentModel = ctx.model
					const parentRegistry = ctx.modelRegistry
					const selection = params.model ?? (parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined)
					const thinkingLevel = params.thinkingLevel ?? pi.getThinkingLevel()
					let cwd = resolve(ctx.cwd, params.cwd ?? ".")
					let session: AgentSession | undefined
					let error: string | undefined
					const runtimeErrors: string[] = []
					const controller = new AbortController()
					let finish!: () => void
					const worker = {
						abort: () => controller.abort(),
						done: new Promise<void>((done) => {
							finish = done
						}),
					}
					workers.add(worker)
					const signals = [...new Set([signal, ctx.signal].filter((item): item is AbortSignal => !!item))]
					const abortSession = () => {
						if (session) void session.abort().catch((failure) => runtimeErrors.push(String(failure)))
					}
					controller.signal.addEventListener("abort", abortSession, { once: true })
					for (const source of signals) {
						source.addEventListener("abort", worker.abort, { once: true })
						if (source.aborted) worker.abort()
					}
					if (stopping) worker.abort()
					try {
						try {
							controller.signal.throwIfAborted()
							cwd = realpathSync(cwd)
							const agentDir = getAgentDir()
							const globalSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: false })
							const trusted =
								cwd === realpathSync(ctx.cwd)
									? ctx.isProjectTrusted()
									: (new ProjectTrustStore(agentDir).get(cwd) ?? globalSettings.getDefaultProjectTrust() === "always")
							const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted })
							const settingsErrors = [...globalSettings.drainErrors(), ...settingsManager.drainErrors()]
							if (settingsErrors.length) throw new Error(settingsErrors.map((item) => item.error.message).join("\n"))
							assertConfiguredExtensionsExist(settingsManager, cwd, agentDir)
							const services = await (options.createServices ?? createAgentSessionServices)({
								cwd,
								agentDir,
								settingsManager,
								modelRuntimeSignal: controller.signal,
								resourceLoaderOptions: {
									additionalExtensionPaths: [packageRoot],
									extensionFactories: [
										{ name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
										{ name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
										{ name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
									],
								},
							})
							controller.signal.throwIfAborted()
							const serviceModelError = services.modelRuntime.getError()
							const errors = [
								...services.diagnostics.filter((item) => item.type === "error").map((item) => item.message),
								...services.resourceLoader.getExtensions().errors.map((item) => `${item.path}: ${item.error}`),
								...services.settingsManager.drainErrors().map((item) => item.error.message),
								...(serviceModelError ? [serviceModelError] : []),
							]
							if (errors.length) throw new Error(errors.join("\n"))
							if (!selection) throw new Error("No parent model selected")
							const selectedProvider = selection.slice(0, selection.indexOf("/"))
							const delegatedProviders = new Set<string>()
							for (const id of new Set([...parentRegistry.getRegisteredProviderIds(), selectedProvider])) {
								const provider = parentRegistry.getProvider(id)
								const parentModel = parentRegistry.getAll().find((model) => model.provider === id)
								if (provider && parentModel) {
									// Keep request-time auth and model headers in the parent registry.
									delegatedProviders.add(id)
									services.modelRuntime.registerNativeProvider({
										...provider,
										auth: {
											apiKey: {
												name: "Parent registry delegation",
												async check() {
													return { type: "api_key" }
												},
												async resolve({ signal }) {
													signal.throwIfAborted()
													return { auth: {} }
												},
											},
										},
										stream: (model, context, request) => parentRegistry.stream<Api>(model, context, request),
										streamSimple: (model, context, request) => parentRegistry.streamSimple(model, context, request),
									})
								} else {
									const native = parentRegistry.getRegisteredNativeProvider(id)
									const config = parentRegistry.getRegisteredProviderConfig(id)
									if (native) services.modelRuntime.registerNativeProvider(native)
									if (config) services.modelRuntime.registerProvider(id, config)
								}
							}
							await services.modelRuntime.refresh({ allowNetwork: false, signal: controller.signal })
							controller.signal.throwIfAborted()
							const modelError = services.modelRuntime.getError()
							if (modelError) throw new Error(modelError)
							const slash = selection.indexOf("/")
							const model = services.modelRuntime.getModel(selection.slice(0, slash), selection.slice(slash + 1))
							if (slash < 1 || !model)
								throw new Error(`Unknown child model: ${selection}; use an exact provider/model ID`)
							controller.signal.throwIfAborted()
							const tools = params.tools === "readonly" ? ["read", "grep", "find", "ls"] : params.tools
							if (tools?.some((name) => name === "codemode" || name === "spawn_agent"))
								throw new Error("Child recursion is disabled")
							const created = await createAgentSessionFromServices({
								services,
								sessionManager: SessionManager.inMemory(cwd),
								model,
								thinkingLevel,
								tools,
								excludeTools: [...(params.excludeTools ?? []), "codemode", "spawn_agent"],
								noTools: params.noTools,
							})
							session = created.session
							const child = session
							const localStream = child.agent.streamFunction
							child.agent.streamFunction = (model, context, request) => {
								if (!delegatedProviders.has(model.provider)) return localStream(model, context, request)
								// Model header expressions need the parent's credential environment.
								const retry = services.settingsManager.getProviderRetrySettings()
								const idleTimeout = services.settingsManager.getHttpIdleTimeoutMs()
								return parentRegistry.streamSimple(model, context, {
									...request,
									timeoutMs: request?.timeoutMs ?? retry.timeoutMs ?? (idleTimeout === 0 ? 2147483647 : idleTimeout),
									websocketConnectTimeoutMs:
										request?.websocketConnectTimeoutMs ?? services.settingsManager.getWebSocketConnectTimeoutMs(),
									maxRetries: request?.maxRetries ?? retry.maxRetries,
									maxRetryDelayMs: request?.maxRetryDelayMs ?? retry.maxRetryDelayMs,
									transformHeaders: (headers) => child.extensionRunner.emitBeforeProviderHeaders(headers),
								})
							}
							controller.signal.throwIfAborted()
							await session.bindExtensions({
								mode: "print",
								onError: (item) => runtimeErrors.push(`${item.extensionPath}: ${item.error}`),
							})
							controller.signal.throwIfAborted()
							if (runtimeErrors.length) throw new Error(runtimeErrors.join("\n"))
							const available = new Set([
								"read",
								"bash",
								"powershell",
								"edit",
								"write",
								"grep",
								"find",
								"ls",
								...services.resourceLoader
									.getExtensions()
									.extensions.flatMap((extension) => [...extension.tools.keys()]),
								...session.getAllTools().map((tool) => tool.name),
							])
							const unknown = [...(tools ?? []), ...(params.excludeTools ?? [])].filter((name) => !available.has(name))
							if (unknown.length) throw new Error(`Unknown child tools: ${unknown.join(", ")}`)
							await session.prompt(params.prompt, {
								source: "extension",
								// abort() cannot cancel idle preflight handlers.
								preflightResult: () => controller.signal.throwIfAborted(),
							})
							const last = [...session.messages].reverse().find((message) => message.role === "assistant")
							if (!last || last.role !== "assistant") throw new Error("Child produced no assistant response")
							if (last.stopReason === "error" || last.stopReason === "aborted")
								throw new Error(last.errorMessage ?? last.stopReason)
						} catch (failure) {
							error = failure instanceof Error ? failure.message : String(failure)
						} finally {
							if (session) {
								try {
									await session.abort()
									await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })
								} catch (failure) {
									runtimeErrors.push(String(failure))
								} finally {
									session.dispose()
								}
							}
						}
						if (runtimeErrors.length) error = [error, ...runtimeErrors].filter(Boolean).join("\n")
						const usage = childUsage(session)
						if (controller.signal.aborted) error = error ?? "Child operation aborted"
						const result = {
							status: controller.signal.aborted ? "aborted" : error ? "error" : "success",
							answer: session?.getLastAssistantText() ?? "",
							...(session ? { sessionId: session.sessionId } : {}),
							...(session?.model ? { model: { provider: session.model.provider, id: session.model.id } } : {}),
							cwd,
							usage: { ...usage, cost: { ...usage.cost } },
							...(error ? { error } : {}),
						}
						return {
							content: [{ type: "text", text: error ?? result.answer }],
							details: result,
							structuredContent: result,
							usage,
							isError: !!error,
						}
					} finally {
						for (const source of signals) source.removeEventListener("abort", worker.abort)
						controller.signal.removeEventListener("abort", abortSession)
						workers.delete(worker)
						finish()
					}
				},
			}),
		)
	}
}

export default createSubagentsExtension()

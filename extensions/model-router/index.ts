import { join } from "node:path"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { type ExtensionAPI, type ExtensionContext, convertToLlm, getAgentDir } from "@earendil-works/pi-coding-agent"
import type { ClassifyTier } from "./classifier"
import { loadConfig, thinkingSchema } from "./config"
import { createRoutingProgress } from "./progress"
import { DECISION_ENTRY, type RouterState, type RoutingDecision, createRouter } from "./router"
import { type RouterSettings, showRouterSettings } from "./settings"
import { MODE_ENTRY, type RouterMode, STATE_ENTRY, readRoutingBranch } from "./state"
import { registerSummaries } from "./summaries"

export { MODE_ENTRY, STATE_ENTRY } from "./state"

export function createModelRouterExtension(options: { configPath?: string; classify?: ClassifyTier } = {}) {
	return (pi: ExtensionAPI) => {
		const { routers, ...settings } = loadConfig(options.configPath ?? join(getAgentDir(), "model-router.json"))
		let mode: RouterMode = { version: 1, enabled: false }
		let states = readRoutingBranch([]).states
		let generation = 0
		let freshPrompt: string | undefined
		let failedResponse: AssistantMessage | undefined
		let routing = false
		let selecting: Promise<boolean> | undefined
		let decision: RoutingDecision | undefined

		let pending:
			| { preset: string; state?: RouterState; decision: RoutingDecision; userBoundary?: string | null }
			| undefined

		const controllers = new Map(
			Object.entries(routers).map(([name, definition]) => [
				name,
				createRouter(
					{ ...settings, ...definition },
					(data) => {
						decision = data
					},
					options.classify,
					createRoutingProgress(`model-router.routing.${name}`),
				),
			]),
		)

		function status(ctx: ExtensionContext) {
			const text = mode.enabled ? `router: on · ${mode.preset}` : "router: off"
			ctx.ui.setStatus(
				"model-router",
				ctx.mode === "tui" ? ctx.ui.theme.fg(mode.enabled ? "accent" : "dim", text) : text,
			)
		}

		function resetRun() {
			generation++
			freshPrompt = undefined
			failedResponse = undefined
			pending = undefined
			decision = undefined

			for (const router of controllers.values()) router.resetRun()
		}

		async function select(choice: RouterState["selection"], ctx: ExtensionContext) {
			const version = generation
			const model = ctx.modelRegistry.find(choice.provider, choice.model)

			if (!model || model.api === "pi-virtual") {
				throw new Error(`physical model ${choice.provider}/${choice.model} is not in Pi's catalog`)
			}

			if (ctx.model?.provider !== model.provider || ctx.model.id !== model.id) {
				const applying = pi.setModel(model)
				selecting = applying

				try {
					if (!(await applying)) throw new Error(`no credentials for ${model.provider}/${model.id}`)
				} finally {
					if (selecting === applying) selecting = undefined
				}
			}

			if (version !== generation) return
			ctx.signal?.throwIfAborted()
			pi.setThinkingLevel(choice.thinking)
		}

		function presetSelection(preset: string) {
			const state = states.get(preset)

			return state?.tier === "trivial"
				? routers[preset].tiers.standard
				: (state?.selection ?? routers[preset].tiers.strong)
		}

		function notifyError(ctx: ExtensionContext, message: string) {
			ctx.ui.notify(`model-router: ${message}`, "error")
		}

		async function restore(ctx: ExtensionContext, reconcileSelection: boolean) {
			resetRun()
			const restored = readRoutingBranch(ctx.sessionManager.getBranch())
			mode = restored.mode
			states = restored.states

			try {
				if (mode.enabled) {
					if (!controllers.has(mode.preset)) throw new Error(`saved preset ${mode.preset} is no longer configured`)
					await select(presetSelection(mode.preset), ctx)
				} else if (reconcileSelection) {
					const projection = ctx.sessionManager.buildSessionProjection()

					if (projection.model && projection.model.provider !== "model-router") {
						const thinking = thinkingSchema.parse(projection.thinkingLevel)
						await select({ ...projection.model, model: projection.model.modelId, thinking }, ctx)
					}
				}
			} catch (error) {
				mode = { version: 1, enabled: false, preset: mode.preset }
				notifyError(ctx, error instanceof Error ? error.message : String(error))
			}

			// Also anchor a /tree visit on disk, even when no physical selection changed.
			pi.appendEntry(MODE_ENTRY, mode)
			status(ctx)
		}

		async function applySettings(next: RouterSettings, ctx: ExtensionContext) {
			if (next.enabled === mode.enabled && next.preset === mode.preset) return

			if (!next.enabled) {
				if (routing) ctx.abort()
				resetRun()
				mode = { version: 1, ...next }
				pi.appendEntry(MODE_ENTRY, mode)
				status(ctx)
				// setModel cannot be cancelled; finish disabling only once its caller settles.
				await selecting?.catch(() => false)

				return
			}

			if (!ctx.isIdle()) throw new Error("wait for the current run before enabling or changing presets")
			const version = generation
			await select(presetSelection(next.preset), ctx)

			if (version !== generation) return
			resetRun()
			mode = { version: 1, ...next }
			pi.appendEntry(MODE_ENTRY, mode)
			status(ctx)
		}

		pi.registerCommand("router", {
			description: "Open automatic model routing settings",
			handler: async (_args, ctx) => {
				if (ctx.mode !== "tui") {
					ctx.ui.notify("model-router: /router settings require TUI mode", "warning")

					return
				}

				const names = [...controllers.keys()]

				const readSettings = (): RouterSettings => ({
					enabled: mode.enabled,
					preset:
						mode.preset && controllers.has(mode.preset)
							? mode.preset
							: (names.find((name) =>
									Object.values(routers[name].tiers).some((target) => target.provider === ctx.model?.provider),
								) ?? names[0]),
				})

				await showRouterSettings(ctx, names, readSettings, (next) => applySettings(next, ctx))
			},
		})

		pi.on("before_agent_start", (event) => {
			if (!mode.enabled) return
			freshPrompt = event.prompt
			controllers.get(mode.preset)?.beginRun(event.prompt, !!event.images?.length)
		})

		pi.on("turn_start", async (_event, ctx) => {
			if (!mode.enabled) return
			const preset = mode.preset
			const router = controllers.get(preset)

			if (!router) return
			const version = generation
			const prompt = freshPrompt
			freshPrompt = undefined
			const branch = ctx.sessionManager.getBranch()
			const failed = failedResponse
			const failedModel = failed && ctx.modelRegistry.find(failed.provider, failed.model)
			const messages = convertToLlm(ctx.sessionManager.buildSessionProjection().messages)

			// turn_start precedes user persistence. recentConversation excludes this pending request.
			if (prompt !== undefined) messages.push({ role: "user", content: prompt, timestamp: Date.now() })
			routing = true
			decision = undefined

			try {
				if (!ctx.model) throw new Error("no selected model")

				const route = await router.route(
					{
						model: ctx.model,
						thinkingLevel: pi.getThinkingLevel(),
						reason: prompt !== undefined ? "user" : failed ? "retry" : "continuation",
						failed: failedModel ? { model: failedModel, thinkingLevel: failed?.thinkingLevel } : undefined,
						state: states.get(preset),
						messages,
						signal: ctx.signal,
					},
					ctx,
				)

				if (version !== generation) return
				ctx.signal?.throwIfAborted()
				await select({ provider: route.model.provider, model: route.model.id, thinking: route.thinkingLevel }, ctx)

				if (version !== generation) return

				if (decision) {
					pending = {
						preset,
						state: route.state,
						decision,
						userBoundary: prompt !== undefined ? (branch.at(-1)?.id ?? null) : undefined,
					}
				}
			} catch (error) {
				pending = undefined

				// Extension hook exceptions otherwise fall through to a stale physical dispatch.
				if (!ctx.signal?.aborted && version === generation) {
					notifyError(ctx, error instanceof Error ? error.message : String(error))
				}

				ctx.abort()
			} finally {
				routing = false
			}
		})

		pi.on("context", (_event, ctx) => {
			const result = pending
			pending = undefined

			if (!result || ctx.signal?.aborted || !mode.enabled || mode.preset !== result.preset) return
			const branch = ctx.sessionManager.getBranch()
			const after = result.userBoundary ? branch.findIndex((entry) => entry.id === result.userBoundary) + 1 : 0

			const user =
				result.userBoundary !== undefined
					? branch.slice(after).find((entry) => entry.type === "message" && entry.message.role === "user")
					: [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role === "user")

			if (result.state) {
				states.set(result.preset, result.state)
				pi.appendEntry(STATE_ENTRY, { version: 1, preset: result.preset, state: result.state })
			}

			pi.appendEntry(DECISION_ENTRY, { ...result.decision, userEntryId: user?.id, router: `auto-${result.preset}` })
		})

		pi.on("turn_end", (event) => {
			const message = event.message
			failedResponse =
				message.role === "assistant" &&
				(message.stopReason === "error" ||
					message.stopReason === "aborted" ||
					(message.stopReason === "length" && !message.content.some((part) => part.type === "toolCall")))
					? message
					: undefined
		})

		// No virtual placeholder or warming override: Pi keeps owning physical selection and idle warming.
		pi.on("agent_settled", () => resetRun())
		pi.on("session_start", (_event, ctx) => restore(ctx, false))
		pi.on("session_tree", (_event, ctx) => restore(ctx, true))
		pi.on("session_shutdown", (_event, ctx) => {
			resetRun()
			ctx.ui.setStatus("model-router", undefined)
		})

		registerSummaries(pi, () => (mode.enabled ? { ...settings, ...routers[mode.preset] } : undefined))
	}
}

export default createModelRouterExtension()

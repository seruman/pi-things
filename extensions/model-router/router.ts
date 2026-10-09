import type { ExtensionContext, ModelRoute, ModelRouteRequest, SessionEntry } from "@earendil-works/pi-coding-agent"
import { z } from "zod"
import { type ClassifyTier, type RoutingInput, TASK_LIMIT, classifyTier } from "./classifier"
import { type RouterConfig, TIERS, type Tier, thinkingSchema } from "./config"

export const ROUTER_PROVIDER = "model-router"
export const DECISION_ENTRY = "model-router.decision"

const stateSchema = z.object({
	version: z.literal(1),
	tier: z.enum(TIERS),
	selection: z.object({ provider: z.string(), model: z.string(), thinking: thinkingSchema }),
	task: z.string().max(TASK_LIMIT),
	toolCursor: z.string().nullable(),
	failures: z.number().int().nonnegative(),
})
export type RouterState = z.infer<typeof stateSchema>
export type RouteRequest = ModelRouteRequest<RouterState>

function lastUserId(branch: readonly SessionEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]
		if (entry.type === "message" && entry.message.role === "user") return entry.id
	}
	return undefined
}

function target(config: RouterConfig, tier: Tier, ctx: ExtensionContext): ModelRoute<RouterState> {
	const choice = config.tiers[tier]
	const model = ctx.modelRegistry.find(choice.provider, choice.model)
	if (!model)
		throw new Error(`model-router: model ${choice.provider}/${choice.model} for ${tier} is not in Pi's catalog`)
	return { model, thinkingLevel: choice.thinking }
}

function selection(route: ModelRoute<RouterState>): RouterState["selection"] {
	return { provider: route.model.provider, model: route.model.id, thinking: route.thinkingLevel }
}

function restoreSelection(state: RouterState, ctx: ExtensionContext): ModelRoute<RouterState> {
	const { provider, model: id, thinking } = state.selection
	const model = ctx.modelRegistry.find(provider, id)
	if (!model) throw new Error(`model-router: saved model ${provider}/${id} is not in Pi's catalog`)
	return { model, thinkingLevel: thinking }
}

/** Scan persisted results, not the compacted transcript; consume each result only once. */
function toolFailures(state: RouterState, branch: readonly SessionEntry[], threshold: number) {
	const start = state.toolCursor === null ? -1 : branch.findIndex((entry) => entry.id === state.toolCursor)
	if (state.toolCursor !== null && start === -1)
		return { failures: 0, escalate: false, cursor: branch.at(-1)?.id ?? null }
	let failures = state.failures
	let escalate = false
	let cursor = state.toolCursor
	for (const entry of branch.slice(start + 1)) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue
		cursor = entry.id
		failures = entry.message.isError ? failures + 1 : 0
		if (failures >= threshold) escalate = true
	}
	// At most one step for a batch: the new model has not had a chance to try yet.
	return { failures: escalate ? 0 : failures, escalate, cursor }
}

export type RecordDecision = (data: Record<string, unknown>) => void

/** Only run-boundary bookkeeping is in memory; decisions live in Pi's branch-persistent state. */
export function createRouter(config: RouterConfig, record: RecordDecision, classify: ClassifyTier = classifyTier) {
	let freshInput: Pick<RoutingInput, "prompt" | "hasImages"> | undefined
	let warnedUnavailable = false

	return {
		beginRun(prompt: string, hasImages: boolean) {
			freshInput = { prompt, hasImages }
		},
		resetRun() {
			freshInput = undefined
		},
		async route(request: RouteRequest, ctx: ExtensionContext): Promise<ModelRoute<RouterState>> {
			request.signal?.throwIfAborted()
			// Compaction/other direct calls must neither classify nor consume the pending user input.
			if (request.reason === "direct") return target(config, "strong", ctx)

			const branch = ctx.sessionManager.getBranch()
			const parsed = stateSchema.safeParse(request.state)
			const state = parsed.success ? parsed.data : undefined
			const input = freshInput
			freshInput = undefined
			const base = { version: 1, reason: request.reason, userEntryId: lastUserId(branch) }
			const recordRoute = (route: ModelRoute<RouterState>, data: Record<string, unknown>) => {
				record({
					...base,
					previousTier: state?.tier,
					provider: route.model.provider,
					model: route.model.id,
					thinking: route.thinkingLevel,
					...data,
				})
				return route
			}

			if (input && request.reason === "user") {
				const decision = await classify(
					config.classifier,
					{ ...input, currentTier: state?.tier, task: state?.task },
					ctx.modelRegistry,
					request.signal,
				)
				request.signal?.throwIfAborted()
				const confidenceGated =
					decision.kind === "classified" && decision.tier !== "strong" && decision.confidence < config.minConfidence
				let tier = decision.kind === "classified" && !confidenceGated ? decision.tier : "strong"
				const continuing = state && decision.kind === "classified" && !decision.newTask && tier === state.tier
				const failures = continuing ? toolFailures(state, branch, config.toolFailureThreshold) : undefined
				const escalated = failures?.escalate && tier !== "strong"
				if (escalated) tier = TIERS[TIERS.indexOf(tier) + 1]
				const route = target(config, tier, ctx)
				route.state = {
					version: 1,
					tier,
					selection: selection(route),
					task:
						decision.kind === "classified" && !decision.newTask && state?.task
							? state.task
							: input.prompt.slice(0, TASK_LIMIT),
					toolCursor: branch.at(-1)?.id ?? null,
					failures: failures?.failures ?? 0,
				}
				if (decision.kind === "classified") warnedUnavailable = false
				else if (decision.reason !== "attachments" && !warnedUnavailable) {
					if (ctx.hasUI)
						ctx.ui.notify(`model-router: local classification failed (${decision.reason}); using strong`, "warning")
					warnedUnavailable = true
				}
				return recordRoute(route, {
					action: confidenceGated ? "confidence-gated" : escalated ? "escalated" : decision.kind,
					tier,
					minConfidence: config.minConfidence,
					classifier: {
						model: config.classifier.model,
						baseUrl: config.classifier.baseUrl,
						timeoutMs: config.classifier.timeoutMs,
						...decision,
					},
				})
			}

			// `previous` skips failed requests and may belong to an older task—even on the same model
			// with different thinking. Saved selection is authoritative; Pi applies the same thinking clamp again.
			const sticky =
				request.reason === "retry" && request.failed ? request.failed : state ? undefined : request.previous
			const tier = state?.tier ?? "strong"
			let route: ModelRoute<RouterState> = sticky
				? { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? config.tiers[tier].thinking }
				: state
					? restoreSelection(state, ctx)
					: target(config, tier, ctx)
			let action = state || sticky ? "retained" : "no-route"
			let nextTier: Tier = tier
			// Retries always preserve the failed model and thinking. Failure escalation waits for a non-retry request.
			if (state && request.reason !== "retry") {
				const failures = toolFailures(state, branch, config.toolFailureThreshold)
				if (failures.escalate && tier !== "strong") {
					nextTier = TIERS[TIERS.indexOf(tier) + 1]
					route = target(config, nextTier, ctx)
					action = "escalated"
				}
				if (nextTier !== tier || failures.failures !== state.failures || failures.cursor !== state.toolCursor) {
					route.state = {
						...state,
						tier: nextTier,
						selection: selection(route),
						failures: failures.failures,
						toolCursor: failures.cursor,
					}
				}
			}
			return recordRoute(route, { action, tier: nextTier })
		},
	}
}

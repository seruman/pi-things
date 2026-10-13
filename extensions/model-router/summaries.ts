import type { StreamFn } from "@earendil-works/pi-agent-core"
import {
	type ExtensionAPI,
	type ExtensionContext,
	SettingsManager,
	compact,
	generateBranchSummary,
	getLatestCompactionEntry,
} from "@earendil-works/pi-coding-agent"
import { z } from "zod"
import type { RouterConfig } from "./config"

// Hook details are persisted, untrusted data; only reuse the native file-list shape.
const fileDetails = z.object({ readFiles: z.array(z.string()), modifiedFiles: z.array(z.string()) })

function summaryRequest(pi: ExtensionAPI, ctx: ExtensionContext, config: RouterConfig) {
	const target = config.tiers.strong
	const model = ctx.modelRegistry.find(target.provider, target.model)

	if (!model) throw new Error(`Strong summary model unavailable: ${target.provider}/${target.model}`)

	if (model.api === "pi-virtual") throw new Error("Strong summary model must be physical")

	const sessionId = ctx.sessionManager.getSessionId()
	const settings = SettingsManager.inMemory(pi.getSettings())

	const streamFn: StreamFn = async (selected, context, options) => {
		const stream = ctx.modelRegistry.streamSimple(selected, context, {
			...options,
			sessionId,
			reasoning: selected.reasoning && target.thinking !== "off" ? target.thinking : undefined,
		})

		const response = await stream.result()

		// compact() does not itself reject aborted or empty provider responses.
		if (response.stopReason === "aborted") throw new Error("Summary generation aborted")

		if (response.stopReason === "stop" && !response.content.some((part) => part.type === "text" && part.text.trim())) {
			throw new Error("Summary generation returned no text")
		}

		return stream
	}

	return { model, settings, streamFn, sessionId, thinking: target.thinking }
}

function cancelSummary(ctx: ExtensionContext, signal: AbortSignal, message: string) {
	try {
		if (!signal.aborted) ctx.ui.notify(`model-router: summary cancelled: ${message}`, "error")
	} catch {
		// Even a UI failure must not escape the hook and enable selected-model fallback.
	}

	return { cancel: true }
}

/** getConfig returns undefined while routing is off; summaries never change physical selection. */
export function registerSummaries(pi: ExtensionAPI, getConfig: () => RouterConfig | undefined): void {
	pi.on("session_before_compact", async (event, ctx) => {
		try {
			const config = getConfig()

			if (!config) return
			event.signal.throwIfAborted()
			const request = summaryRequest(pi, ctx, config)
			const { preparation } = event
			const previous = getLatestCompactionEntry(event.branchEntries)
			const prior = fileDetails.safeParse(previous?.fromHook ? previous.details : undefined)

			// Pi ignores fromHook details on the next preparation. Copy rather than mutate its sets.
			const fileOps = {
				read: new Set([...preparation.fileOps.read, ...(prior.success ? prior.data.readFiles : [])]),
				written: new Set(preparation.fileOps.written),
				edited: new Set([...preparation.fileOps.edited, ...(prior.success ? prior.data.modifiedFiles : [])]),
			}

			const result = await compact(
				{ ...preparation, fileOps },
				request.model,
				undefined,
				undefined,
				event.customInstructions,
				event.signal,
				request.thinking,
				request.streamFn,
				undefined,
				request.settings.getRetrySettings(),
				undefined,
				request.sessionId,
			)

			event.signal.throwIfAborted()

			return { compaction: result }
		} catch (error) {
			return cancelSummary(ctx, event.signal, error instanceof Error ? error.message : String(error))
		}
	})

	pi.on("session_before_tree", async (event, ctx) => {
		const { preparation, signal } = event

		if (!preparation.userWantsSummary || preparation.entriesToSummarize.length === 0) return

		try {
			const config = getConfig()

			if (!config) return
			signal.throwIfAborted()
			const request = summaryRequest(pi, ctx, config)

			const entries = preparation.entriesToSummarize.map((entry) => {
				if (entry.type !== "branch_summary" || !entry.fromHook) return entry
				const details = fileDetails.safeParse(entry.details)

				// Let the native helper accumulate recognized hook file lists, without rewriting history.
				return details.success ? { ...entry, fromHook: false, details: details.data } : entry
			})

			const result = await generateBranchSummary(entries, {
				model: request.model,
				signal,
				customInstructions: preparation.customInstructions,
				replaceInstructions: preparation.replaceInstructions,
				reserveTokens: request.settings.getBranchSummarySettings().reserveTokens,
				streamFn: request.streamFn,
				retry: request.settings.getRetrySettings(),
			})

			signal.throwIfAborted()

			if (result.aborted || result.error || !result.summary?.trim()) {
				return cancelSummary(ctx, signal, result.error ?? "Summary generation aborted or empty")
			}

			return {
				summary: {
					summary: result.summary,
					usage: result.usage,
					details: { readFiles: result.readFiles ?? [], modifiedFiles: result.modifiedFiles ?? [] },
				},
			}
		} catch (error) {
			return cancelSummary(ctx, signal, error instanceof Error ? error.message : String(error))
		}
	})
}

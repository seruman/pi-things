import { sessionIdSchema } from "../lib/session-delivery/identity"
import { onShellLeashDenial } from "../shell-leash/denial"
import type { BridgeContext, BridgeHost } from "./contracts"
import { publishCompletion, type CompletionSnapshot } from "./completion"
import { type RunMetadata, readMetadata, readRunIdentity, updateMetadata } from "./runs"
import { acknowledgeStop, clearStopAcknowledgement, stopAcknowledged, stopRequested } from "./stop"

type BridgePatch = Partial<
	Pick<RunMetadata, "sessionFiles" | "sessionFile" | "childSessionId" | "state" | "hasStarted" | "outcome" | "error">
>

function settledOutcome(ctx: BridgeContext): RunMetadata["outcome"] {
	const entry = ctx.sessionManager
		.getBranch()
		.findLast((entry) => entry.type === "message" && entry.message.role === "assistant")

	if (entry?.type !== "message" || entry.message.role !== "assistant") return undefined
	const reason = entry.message.stopReason

	return reason === "error" ? "error" : reason === "aborted" ? "aborted" : "success"
}

export function installBridge(pi: BridgeHost, runDir: string): void {
	let current: BridgeContext | undefined
	let timer: ReturnType<typeof setInterval> | undefined
	let sessionName: string | undefined
	let sessionPending = true
	let hasStarted = false
	let denial: string | undefined
	let abortRequested = false
	let responseBoundary: Set<string> | undefined
	const earlyCompletions: CompletionSnapshot[] = []
	let lastOutcome: RunMetadata["outcome"]

	const flushCompletions = () => {
		const run = readRunIdentity(runDir) ?? readMetadata(runDir)

		if (!run) return

		while (earlyCompletions.length) {
			const fact = earlyCompletions[0]

			if (!fact) break
			publishCompletion(run, fact)
			earlyCompletions.shift()
		}
	}

	const update = (patch: BridgePatch, clear?: Parameters<typeof updateMetadata>[2]) =>
		updateMetadata(runDir, patch, clear)

	onShellLeashDenial(pi.events, (reason) => {
		denial ??= reason
	})

	// Unlike tmux, Rex assigns the block id at launch, so metadata can arrive after session_start.
	const initializeSession = (): boolean => {
		if (!current) return false

		if (!sessionPending) return true
		const metadata = readMetadata(runDir)

		if (!metadata) return false

		const sessionFile = current.sessionManager.getSessionFile() ?? metadata.sessionFile

		const patch: BridgePatch = {
			sessionFiles: [...new Set([...(metadata.sessionFiles ?? []), metadata.sessionFile, sessionFile])],
			childSessionId: sessionIdSchema.parse(current.sessionManager.getSessionId()),
			sessionFile,
			state: current.isIdle() ? "idle" : "busy",
		}

		if (hasStarted) patch.hasStarted = true

		if (current.isIdle()) {
			patch.outcome =
				lastOutcome ??
				(metadata.sessionFile === sessionFile ? (metadata.outcome ?? settledOutcome(current)) : settledOutcome(current))
		}

		if (denial && current.isIdle()) {
			patch.state = "error"
			patch.error = denial
		}

		const updated = update(patch, patch.error ? ["suspended"] : ["suspended", "error"])

		if (!updated) return false
		sessionPending = false
		flushCompletions()

		return true
	}

	// Keep the child title in sync with renames, as in pi-subagent.
	const syncSessionName = (): void => {
		const metadata = readMetadata(runDir)

		if (!metadata) return
		const next = `subagent ${metadata.name ?? metadata.handle}`

		if (next === sessionName) return
		pi.setSessionName(next)
		sessionName = next
	}

	// Abort through Pi, not Rex. isIdle/agent_settled only become true after the
	// interrupted response and its available usage have reached the transcript.
	const processStop = (): boolean => {
		const run = readMetadata(runDir)

		if (!current || !run || !stopRequested(run)) {
			abortRequested = false

			return false
		}

		if (!current.isIdle()) clearStopAcknowledgement(run)

		if (!abortRequested) {
			abortRequested = true
			current.abort()
		}

		if (current.isIdle() && !stopAcknowledged(run)) acknowledgeStop(run)

		return true
	}

	const poll = (): void => {
		if (!current || !initializeSession() || processStop()) return
		syncSessionName()
	}

	pi.on("session_start", (_event, ctx) => {
		current = ctx
		sessionPending = true
		denial = undefined

		if (!timer) {
			// Rex may start the child before the parent has written its metadata.
			timer = setInterval(poll, 250)
			timer.unref()
		}

		poll()
	})

	pi.on("agent_start", (_event, ctx) => {
		current = ctx
		hasStarted = true
		responseBoundary ??= new Set(ctx.sessionManager.getBranch().map((entry) => entry.id))
		denial = undefined
		update({ state: "busy", hasStarted: true }, ["error"])
		// Initial CLI prompts and already queued work can start after an idle poll.
		// A stop request remains latched until the parent closes or resumes the child.
		abortRequested = false
		processStop()
	})

	pi.on("agent_settled", (event, ctx) => {
		current = ctx

		if (ctx.isIdle()) {
			const entry = [...ctx.sessionManager.getBranch()]
				.reverse()
				.find(
					(entry) => entry.type === "message" && entry.message.role === "assistant" && !responseBoundary?.has(entry.id),
				)

			const sessionFile = ctx.sessionManager.getSessionFile()
			const outcome = denial ? "error" : event.aborted ? "aborted" : (settledOutcome(ctx) ?? "error")
			lastOutcome = outcome

			if (sessionFile) {
				const snapshot: CompletionSnapshot = {
					childSessionId: sessionIdSchema.parse(ctx.sessionManager.getSessionId()),
					sessionFile,
					outcome,
					response: entry ? { kind: "response", entryId: entry.id } : { kind: "none" },
				}

				earlyCompletions.push(denial ? { ...snapshot, error: denial } : snapshot)
			}

			flushCompletions()
			responseBoundary = undefined
			// Publish only after cancellation settles, not while sibling tools may still be running.
			update(
				denial
					? { state: "error", error: denial, outcome: "error" }
					: { state: "idle", outcome: event.aborted ? "aborted" : settledOutcome(ctx) },
			)
			processStop()
		}
	})

	pi.on("session_shutdown", (event) => {
		current = undefined
		responseBoundary = undefined

		if (timer) {
			clearInterval(timer)
			timer = undefined
		}

		if (event.reason === "quit") update({ state: "exited" })
	})
}

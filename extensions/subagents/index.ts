import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
	type AssistantMessage,
	type JsonValue,
	type Static,
	type TSchema,
	StringEnum,
	type TextContent,
	Type,
} from "@earendil-works/pi-ai"
import {
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	SessionManager,
	getAgentDir,
} from "@earendil-works/pi-coding-agent"
import { type SelectItem, SelectList } from "@earendil-works/pi-tui"
import { getChildPolicyArgs } from "../shell-leash/child-policy"
import { workStatus, type WorkStatus } from "../lib/session-delivery/mailbox"
import {
	runHandleSchema,
	sessionIdSchema,
	type InstanceId,
	type RunHandle,
	type SessionId,
} from "../lib/session-delivery/identity"
import { acquireDelivery, type DeliveryService } from "../lib/session-delivery/runtime"
import { familyPolicy, ownedRun } from "./family"
import { installPrivateChild } from "./private-child"
import { getPiInvocationParts } from "../split-fork"
import { UsageAccounting } from "./accounting"
import { installBridge } from "./bridge"
import type { ParentContext, ParentHost, SubagentTool } from "./contracts"
import { CompletionCoordinator, completionAnswer, readCompletion, type CompletionInvocation } from "./completion"
import { isManagedChildLaunch, parentExtensionFlags } from "./parent-flags"
import { ProgramStatusReporter } from "./program-status"
import {
	type Exec,
	type RunState,
	closeBlock,
	effectiveRunState,
	newBlock,
	readProcess,
	runStates,
	showBlock,
} from "./rex"
import {
	type RunMetadata,
	getRun,
	listRuns,
	markStopped,
	normalizeRunName,
	prepareRun,
	runDirectory,
	runDisplayName,
	thinkingLevels,
	updateMetadata,
	writeMetadata,
} from "./runs"
import { clearStopSignals, requestStop, stopAcknowledged, stopRequested } from "./stop"
import { childUsage } from "./usage"

const EXCLUDED = ["codemode", "agent_spawn", "agent_send", "agent_wait", "agent_stop", "agent_list", "agent_rename"]

const READONLY = ["read", "grep", "find", "ls"]

type FamilyDelivery = Pick<DeliveryService, "send" | "stageCompletion" | "assertContext">

const usageSchema = Type.Object({
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
})

const modelSchema = Type.Object({ provider: Type.String(), id: Type.String() })

const runResultSchema = Type.Object({
	handle: Type.String(),
	name: Type.Optional(Type.String()),
	blockId: Type.String(),
	sessionFile: Type.String(),
	status: Type.Union([Type.Literal("success"), Type.Literal("error"), Type.Literal("aborted")]),
	answer: Type.String(),
	model: modelSchema,
	cwd: Type.String(),
	usage: usageSchema,
	usageScope: Type.Literal("session-cumulative"),
	error: Type.Optional(Type.String()),
})

const backgroundSchema = Type.Object({
	handle: Type.String(),
	name: Type.Optional(Type.String()),
	blockId: Type.String(),
	sessionFile: Type.String(),
	cwd: Type.String(),
	model: modelSchema,
})

const spawnSchema = Type.Union([runResultSchema, backgroundSchema])

const handleSchema = Type.Object({ handle: Type.String() })

const listSchema = Type.Object({
	runs: Type.Array(
		Type.Object({
			handle: Type.String(),
			name: Type.Optional(Type.String()),
			blockId: Type.String(),
			sessionFile: Type.String(),
			cwd: Type.String(),
			model: modelSchema,
			thinking: StringEnum(thinkingLevels),
			state: StringEnum(runStates),
			stoppedAt: Type.Optional(Type.String()),
			error: Type.Optional(Type.String()),
		}),
	),
})

type RunResult = Static<typeof runResultSchema>

type BackgroundResult = Static<typeof backgroundSchema>

function toolResult<T extends JsonValue>(body: T, text: string, options?: { isError?: boolean }): AgentToolResult<T> {
	const result: AgentToolResult<T> = {
		content: [{ type: "text", text }],
		details: body,
		structuredContent: body,
	}

	if (options?.isError) result.isError = true

	return result
}

const nameParameter = Type.String({
	description: "Display name: a single line of 1 to 64 characters, trimmed. Handles remain the stable identifiers.",
})

const spawnParameters = Type.Object({
	prompt: Type.String({ minLength: 1 }),
	name: Type.Optional(nameParameter),
	cwd: Type.Optional(Type.String()),
	provider: Type.Optional(Type.String({ description: "Provider id. Defaults to the parent's provider." })),
	model: Type.Optional(
		Type.String({
			description: "Model id. Defaults to the parent's model. Set alongside provider for cross-provider use.",
		}),
	),
	thinkingLevel: Type.Optional(StringEnum(thinkingLevels)),
	tools: Type.Optional(Type.Union([Type.Literal("readonly"), Type.Array(Type.String())])),
	excludeTools: Type.Optional(Type.Array(Type.String())),
	noTools: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("builtin")])),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Return immediately instead of waiting for the initial turn. Successful completion leaves the child alive in either mode.",
		}),
	),
})

type SpawnParameters = Static<typeof spawnParameters>

function toolFlags(params: SpawnParameters): string[] {
	const tools = params.tools === "readonly" ? READONLY : params.tools
	const exclude = [...EXCLUDED, ...(params.excludeTools ?? [])]
	const args: string[] = []

	if (tools?.length) args.push("--tools", tools.join(","))
	args.push("--exclude-tools", exclude.join(","))

	if (params.noTools === "all") args.push("--no-tools")

	if (params.noTools === "builtin") args.push("--no-builtin-tools")

	return args
}

function launchCommand(run: Omit<RunMetadata, "blockId">, initial: string[] = []): string[] {
	return [
		"env",
		`PI_CODING_AGENT_DIR=${getAgentDir()}`,
		`PI_SUBAGENT_RUN_DIR=${runDirectory(run.handle, run.parentSessionId)}`,
		...getPiInvocationParts(),
		// Load this bridge even when the installed package is older or cwd differs.
		"--extension",
		fileURLToPath(import.meta.url),
		"--session",
		run.launchSessionFile ?? run.sessionFile,
		"--provider",
		run.provider,
		"--model",
		run.model,
		"--thinking",
		run.thinking,
		...run.launchArgs,
		...initial,
	]
}

function assistantText(message: AssistantMessage): string {
	const text = message.content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim()

	return text || message.errorMessage || "(no response text)"
}

function isAssistantEntry(entry: SessionEntry): entry is SessionEntry & { type: "message"; message: AssistantMessage } {
	return entry.type === "message" && entry.message.role === "assistant"
}

function latestAssistant(session: SessionManager): AssistantMessage | undefined {
	return session.getBranch().findLast(isAssistantEntry)?.message
}

function resultOf(
	run: RunMetadata,
	status: RunResult["status"],
	answer: string,
	session: SessionManager,
	error?: string,
): RunResult {
	const result: RunResult = {
		handle: run.handle,
		blockId: run.blockId,
		sessionFile: run.sessionFile,
		status,
		answer,
		model: { provider: run.provider, id: run.model },
		cwd: run.cwd,
		usage: childUsage(session.getEntries()),
		usageScope: "session-cumulative",
	}

	if (run.name !== undefined) result.name = run.name

	if (error) result.error = error

	return result
}

function outcome(run: RunMetadata, message: AssistantMessage, answer: string, session: SessionManager): RunResult {
	if (message.stopReason === "error") return resultOf(run, "error", answer, session, message.errorMessage)

	if (message.stopReason === "aborted") return resultOf(run, "aborted", answer, session)

	return resultOf(run, "success", answer, session)
}

function assertNotStopped(run: RunMetadata): void {
	if (run.stoppedAt) throw new Error(`${run.handle} is stopped; read its retained history at ${run.sessionFile}`)
}

// Closing and retaining a run is shared by explicit stop and foreground cancellation.
async function stopRun(
	exec: Exec,
	handle: RunHandle,
	options: { parentSessionId: SessionId; force?: boolean; signal?: AbortSignal },
): Promise<RunMetadata> {
	const run = ownedRun({ handle, parentSessionId: options.parentSessionId })

	if (run.stoppedAt) return run
	const { signal } = options

	if (!options.force) {
		let seen = await readProcess(exec, run.blockId, signal)

		if (seen.alive) {
			requestStop(run)
			const deadline = Date.now() + 10_000

			while (!stopAcknowledged(run)) {
				signal?.throwIfAborted()

				if (!seen.alive || ownedRun({ handle, parentSessionId: run.parentSessionId }).stoppedAt) break

				if (Date.now() >= deadline) {
					throw new Error(
						`${handle} did not finish graceful stop within 10 seconds; retry or use agent_stop({ handle: "${handle}", force: true }) to kill it. Force may lose unsaved usage.`,
					)
				}

				await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
				seen = await readProcess(exec, run.blockId, signal)
			}
		}
	}

	const current = ownedRun({ handle, parentSessionId: run.parentSessionId })

	if (current.blockId !== run.blockId || current.relation !== run.relation) {
		throw new Error("Child launch identity changed during stop")
	}

	try {
		await closeBlock(exec, run.blockId, signal)
	} catch (error) {
		// Another stop may have closed it while this call was awaiting Rex.
		if ((await readProcess(exec, run.blockId, signal)).exists) throw error
	}

	// Re-read after closing: the bridge may have updated its session path or final state.
	ownedRun({ handle, parentSessionId: run.parentSessionId })

	return markStopped(handle, run.parentSessionId)
}

async function settle(
	exec: Exec,
	initialRun: RunMetadata,
	signal?: AbortSignal,
	timeoutSec = 1800,
	invocation?: CompletionInvocation,
): Promise<RunResult> {
	if (!Number.isInteger(timeoutSec) || timeoutSec <= 0) throw new Error("timeoutSec must be a positive integer")
	let run = initialRun
	let messagingInstance: InstanceId | undefined

	const messagingStatus = () => {
		const status = workStatus(
			{
				sessionId: run.childSessionId,
				sessionFile: run.sessionFile,
				instanceId: messagingInstance,
			},
			undefined,
			familyPolicy,
		)

		if (status.kind !== "unavailable" && status.instanceId) messagingInstance ??= status.instanceId

		return status
	}

	const initialMessaging = messagingStatus()

	// Read the transcript only when returning, never during startup/busy polling.
	const finish = (status?: RunResult["status"], error?: string): RunResult => {
		run = ownedRun({ handle: run.handle, parentSessionId: initialRun.parentSessionId })
		const session = SessionManager.open(run.sessionFile)
		const fact = readCompletion(run)
		const response = fact?.response

		const onBranch =
			response?.kind === "none" ||
			(response?.kind === "response" && session.getBranch().some((entry) => entry.id === response.entryId))

		if (!status && fact && fact.sessionFile === run.sessionFile && fact.childSessionId === run.childSessionId) {
			const { answer } = completionAnswer(fact)

			if (onBranch) {
				const result = resultOf(
					run,
					fact.outcome,
					answer,
					session,
					fact.error ?? (fact.outcome === "error" ? (run.error ?? `${run.handle} failed`) : undefined),
				)

				invocation?.terminal(fact)

				return result
			}
		}

		const latest = latestAssistant(session)
		const answer = latest ? assistantText(latest) : ""

		if (status) return resultOf(run, status, answer, session, error)

		// A legacy bridge loaded alongside this one may mark a denied run idle without clearing its error.
		if (run.error) return resultOf(run, "error", answer, session, run.error)

		if (!latest) return resultOf(run, "error", answer, session, `${run.handle} finished without an assistant response`)

		return outcome(run, latest, answer, session)
	}

	const interruptedResult = (status: Extract<WorkStatus, { kind: "interrupted" }>) => {
		if (status.origin === "observer") return finish("error", status.reason)
		const fact = readCompletion(run)

		return fact && fact.outcome !== "success" && (run.state === "idle" || run.state === "error")
			? finish()
			: finish("error", status.reason)
	}

	if (initialMessaging.kind === "interrupted") return interruptedResult(initialMessaging)
	const deadline = Date.now() + timeoutSec * 1000

	while (Date.now() < deadline) {
		run = ownedRun({ handle: run.handle, parentSessionId: initialRun.parentSessionId })
		assertNotStopped(run)

		// Waiting observes the child; the caller decides whether cancellation also stops it.
		if (signal?.aborted) return finish("aborted")

		const beforeInspection = messagingStatus()

		if (beforeInspection.kind === "interrupted") return interruptedResult(beforeInspection)

		if (run.state === "error" && beforeInspection.kind !== "pending") {
			return readCompletion(run) ? finish() : finish("error", run.error ?? `${run.handle} failed`)
		}

		let alive: boolean

		try {
			alive = (await readProcess(exec, run.blockId, signal)).alive
		} catch (error) {
			if (!signal?.aborted) throw error

			return finish("aborted")
		}

		// The bridge may finish or switch sessions during the asynchronous liveness query.
		run = ownedRun({ handle: run.handle, parentSessionId: initialRun.parentSessionId })

		if (!alive || run.state === "exited") return finish("error", `${run.handle} exited before finishing`)

		const messaging = messagingStatus()

		if (messaging.kind === "interrupted") return interruptedResult(messaging)

		if (run.state === "error" && messaging.kind !== "pending") {
			return readCompletion(run) ? finish() : finish("error", run.error ?? `${run.handle} failed`)
		}

		if (run.hasStarted && run.state === "idle" && messaging.kind !== "pending") {
			if (messaging.kind === "unavailable" && run.relation) {
				return finish("error", "Session messaging receiver is unavailable; delivery outcome unknown")
			}

			return finish()
		}

		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
	}

	return finish("error", `timeout after ${timeoutSec}s`)
}

async function spawn(
	exec: Exec,
	pi: ParentHost,
	ctx: ParentContext,
	params: SpawnParameters,
	signal: AbortSignal | undefined,
	invocation: CompletionInvocation,
): Promise<RunMetadata> {
	const provider = params.provider ?? ctx.model?.provider
	const model = params.model ?? ctx.model?.id

	if (!provider) throw new Error("No provider specified and ctx.model is not set")

	if (!model) throw new Error("No model specified and ctx.model is not set")
	const name = params.name === undefined ? undefined : normalizeRunName(params.name)
	const thinking = params.thinkingLevel ?? pi.getThinkingLevel()
	const cwd = resolve(ctx.cwd, params.cwd ?? ".")

	const launchArgs = [
		...parentExtensionFlags(process.argv.slice(2), process.cwd()),
		...toolFlags(params),
		...getChildPolicyArgs(pi.events),
	]

	const parentSessionId = sessionIdSchema.parse(ctx.sessionManager.getSessionId())
	const prepared = prepareRun(parentSessionId)

	if (!params.background) invocation.reserve(prepared.handle)

	const draft: Omit<RunMetadata, "blockId"> = {
		version: 1,
		accountingVersion: 1,
		handle: prepared.handle,
		relation: prepared.relation,
		parentSessionId,
		sessionFile: prepared.sessionFile,
		launchSessionFile: prepared.sessionFile,
		cwd,
		provider,
		model,
		thinking,
		launchArgs,
		state: "starting",
		hasStarted: false,
		createdAt: new Date().toISOString(),
	}

	if (name !== undefined) draft.name = name

	try {
		const blockId = await newBlock(exec, cwd, prepared.handle, launchCommand(draft, [params.prompt]), signal)
		const run: RunMetadata = { ...draft, blockId }
		writeMetadata(run)

		return run
	} catch (error) {
		// A failed launch response does not prove the child never wrote history.
		throw new Error(
			`Could not spawn subagent ${prepared.handle}; files retained at ${runDirectory(prepared.handle, parentSessionId)}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		)
	}
}

function settledResult(settled: RunResult): AgentToolResult<RunResult> {
	return toolResult(settled, settled.error ?? settled.answer, {
		isError: settled.status !== "success",
	})
}

type DisplayStatus = { state: RunState; error?: string }

// Presentation must isolate failed Rex queries without mistaking them for child exits/errors.
async function displayStatus(exec: Exec, run: RunMetadata, signal?: AbortSignal): Promise<DisplayStatus> {
	try {
		signal?.throwIfAborted()
		const state = await effectiveRunState(exec, run, signal)
		const status: DisplayStatus = { state }

		if (run.error) status.error = run.error

		return status
	} catch (error) {
		if (signal?.aborted) throw error

		return { state: "unknown", error: error instanceof Error ? error.message : String(error) }
	}
}

function choose(ui: Pick<ExtensionContext["ui"], "custom">, items: SelectItem[]): Promise<string | undefined> {
	return ui.custom((tui, theme, _keybindings, done) => {
		const list = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		})

		list.onSelect = (item) => done(item.value)
		list.onCancel = () => done(undefined)

		return {
			render: (width) => list.render(width),
			invalidate: () => list.invalidate(),
			handleInput: (data) => {
				list.handleInput(data)
				tui.requestRender()
			},
		}
	})
}

export default function (pi: ExtensionAPI) {
	const delivery = acquireDelivery(pi)

	if (!delivery.claim("subagents")) return
	delivery.setFamilyPolicy(familyPolicy)
	const childRun = process.env.PI_SUBAGENT_RUN_DIR

	if (childRun && isManagedChildLaunch(childRun, process.argv.slice(2), process.cwd())) {
		installBridge(pi, childRun)
		installPrivateChild(pi, childRun, delivery)

		return
	}

	installParent(pi, undefined, delivery)
}

export function installParent(
	pi: ParentHost,
	programStatus = new ProgramStatusReporter(),
	delivery?: FamilyDelivery,
): void {
	const exec: Exec = (command, args, signal) => pi.exec(command, args, signal ? { signal } : {})
	let widgetTimer: ReturnType<typeof setInterval> | undefined
	let widgetContext: ParentContext | undefined
	let refreshingWidget = false
	const accounting = new UsageAccounting(pi)
	const completions = new CompletionCoordinator(pi, delivery)
	let completionTimer: ReturnType<typeof setInterval> | undefined
	let lastCompletionError: string | undefined
	let accountingTimer: ReturnType<typeof setInterval> | undefined
	let lastAccountingError: string | undefined

	// Ported from pi-subagent; Rex status calls are asynchronous, unlike tmux's.
	const refreshWidget = async (): Promise<void> => {
		if (!widgetContext || refreshingWidget) return
		const ctx = widgetContext
		refreshingWidget = true

		try {
			const statuses = await Promise.all(
				listRuns(sessionIdSchema.parse(ctx.sessionManager.getSessionId())).map(async (run) => ({
					run,
					...(await displayStatus(exec, run)),
				})),
			)

			if (widgetContext !== ctx) return
			programStatus.sync(
				statuses.map(({ run, state }) => ({
					run,
					state,
				})),
			)

			const activeRuns = statuses.filter(
				({ state }) => state !== "exited" && state !== "suspended" && state !== "stopped",
			)

			if (activeRuns.length === 0) {
				ctx.ui.setWidget("subagents", undefined)

				return
			}

			const visible = activeRuns.slice(0, 5).map(({ run, state }) => {
				const color =
					state === "busy"
						? "warning"
						: state === "idle"
							? "success"
							: state === "error" || state === "unknown"
								? "error"
								: "muted"

				return ctx.ui.theme.fg(color, `${run.name ?? run.handle}:${state}`)
			})

			if (activeRuns.length > visible.length) {
				visible.push(ctx.ui.theme.fg("muted", `+${activeRuns.length - visible.length}`))
			}

			ctx.ui.setWidget(
				"subagents",
				[ctx.ui.theme.fg("dim", "subagents: ") + visible.join(ctx.ui.theme.fg("dim", " | "))],
				{ placement: "belowEditor" },
			)
		} catch {
			if (widgetContext === ctx) {
				ctx.ui.setWidget("subagents", [ctx.ui.theme.fg("error", "subagents: status unavailable")], {
					placement: "belowEditor",
				})
			}
		} finally {
			refreshingWidget = false
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		completions.start(ctx)
		lastCompletionError = undefined

		if (completionTimer) clearInterval(completionTimer)
		completionTimer = setInterval(() => {
			try {
				completions.scan()
				lastCompletionError = undefined
			} catch (error) {
				const reason = `Subagent completion scan failed: ${String(error)}`

				if (reason !== lastCompletionError) pi.appendEntry("session-message-error", reason)
				lastCompletionError = reason
			}
		}, 200)
		completionTimer.unref()
		widgetContext = undefined

		if (widgetTimer) clearInterval(widgetTimer)
		widgetTimer = undefined
		programStatus.dispose()
		accounting.reconcile(ctx, "start")

		if (accountingTimer) clearInterval(accountingTimer)
		accountingTimer = setInterval(() => {
			try {
				accounting.reconcile(ctx, "poll")
				lastAccountingError = undefined
			} catch (error) {
				const message = `Subagent accounting failed: ${error instanceof Error ? error.message : String(error)}`

				if (message === lastAccountingError) return
				lastAccountingError = message

				if (ctx.hasUI) ctx.ui.notify(message, "error")
				else console.error(message)
			}
		}, 5000)
		accountingTimer.unref()

		for (const run of listRuns(sessionIdSchema.parse(ctx.sessionManager.getSessionId()))) {
			if (!run.suspended) continue

			try {
				const seen = await readProcess(exec, run.blockId)

				if (seen.alive) {
					clearStopSignals(run)
					updateMetadata(runDirectory(run.handle, run.parentSessionId), { suspended: false })
					continue
				}

				if (seen.exists) await closeBlock(exec, run.blockId)

				if (!existsSync(run.sessionFile)) {
					updateMetadata(runDirectory(run.handle, run.parentSessionId), {
						state: "error",
						error: `Cannot resume: transcript missing at ${run.sessionFile}`,
					})
					markStopped(run.handle, run.parentSessionId)
					continue
				}

				clearStopSignals(run)

				const starting = updateMetadata(
					runDirectory(run.handle, run.parentSessionId),
					{ state: "starting", launchSessionFile: run.sessionFile },
					["error"],
				)

				if (!starting) throw new Error(`Cannot resume: metadata missing for ${run.handle}`)
				const blockId = await newBlock(exec, run.cwd, run.handle, launchCommand(starting))
				updateMetadata(runDirectory(run.handle, run.parentSessionId), { blockId, suspended: false })
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				updateMetadata(runDirectory(run.handle, run.parentSessionId), { state: "error", error: message })

				if (ctx.hasUI) ctx.ui.notify(`Could not resume subagent ${runDisplayName(run)}: ${message}`, "error")
			}
		}

		if (!ctx.hasUI) return
		programStatus.start(ctx)
		widgetContext = ctx

		if (widgetTimer) clearInterval(widgetTimer)
		widgetTimer = setInterval(() => void refreshWidget(), 1000)
		widgetTimer.unref()
		await refreshWidget()
	})

	pi.on("agent_settled", (_event, ctx) => {
		accounting.releaseReservations(ctx)
		accounting.reconcile(ctx, "settled")
	})

	pi.on("session_shutdown", async (event, ctx) => {
		completions.stop()

		if (completionTimer) clearInterval(completionTimer)
		completionTimer = undefined
		accounting.releaseReservations(ctx)

		if (accountingTimer) clearInterval(accountingTimer)
		accountingTimer = undefined

		if (widgetTimer) clearInterval(widgetTimer)
		widgetTimer = undefined
		widgetContext = undefined
		programStatus.dispose()

		if (ctx.hasUI) ctx.ui.setWidget("subagents", undefined)

		if (event.reason === "reload") {
			accounting.reconcile(ctx, "reload")

			return
		}

		const failures: Error[] = []

		for (const run of listRuns(sessionIdSchema.parse(ctx.sessionManager.getSessionId()))) {
			try {
				const seen = await readProcess(exec, run.blockId)

				if (!seen.alive) {
					if (seen.exists) await closeBlock(exec, run.blockId)

					if (!run.suspended) markStopped(run.handle, run.parentSessionId)
					continue
				}

				updateMetadata(runDirectory(run.handle, run.parentSessionId), { suspended: true })
				await closeBlock(exec, run.blockId)
			} catch (error) {
				failures.push(error instanceof Error ? error : new Error(String(error)))
			}
		}

		accounting.reconcile(ctx, "shutdown")

		if (failures.length > 0) throw new AggregateError(failures, "subagent suspend failed")
	})

	registerCommand(pi, exec)
	registerTools(pi, exec, accounting, completions, delivery)
}

function registerCommand(pi: ParentHost, exec: Exec): void {
	pi.registerCommand("subagent", {
		description: "Restore and focus a subagent spawned by this session",
		handler: async (_args, ctx) => {
			const runs = listRuns(sessionIdSchema.parse(ctx.sessionManager.getSessionId()))
			const items: SelectItem[] = []

			for (const run of runs) {
				const status = await displayStatus(exec, run)

				if (status.state === "exited" || status.state === "suspended" || status.state === "stopped") continue

				const item: SelectItem = {
					value: run.handle,
					label: `${runDisplayName(run)}  ${status.state.padEnd(8)}  ${run.provider}/${run.model}  ${run.thinking}`,
				}

				if (status.error) item.description = status.error
				items.push(item)
			}

			if (items.length === 0) {
				ctx.ui.notify("No subagents", "info")

				return
			}

			const selected = await choose(ctx.ui, items)

			if (!selected) return
			const run = getRun(runHandleSchema.parse(selected), sessionIdSchema.parse(ctx.sessionManager.getSessionId()))
			await showBlock(exec, run.blockId)
		},
	})
}

type InternalTool<Params extends TSchema, Result extends JsonValue> = Omit<SubagentTool<Params, Result>, "execute"> & {
	execute(
		...args: [...Parameters<SubagentTool<Params, Result>["execute"]>, CompletionInvocation]
	): ReturnType<SubagentTool<Params, Result>["execute"]>
}

function registerTools(
	pi: ParentHost,
	exec: Exec,
	accounting: UsageAccounting,
	completions: CompletionCoordinator,
	delivery?: FamilyDelivery,
): void {
	const registerTool = <Params extends TSchema, Result extends JsonValue>(tool: InternalTool<Params, Result>) =>
		pi.registerTool({
			...tool,
			async execute(id, params, signal, update, ctx) {
				delivery?.assertContext(ctx)
				const invocation = completions.invocation(ctx)

				try {
					let result

					try {
						result = await tool.execute(id, params, signal, update, ctx, invocation)
					} finally {
						accounting.reconcile(ctx, tool.name)
					}

					const usage = accounting.charge(ctx, id)

					if (usage) result.usage = usage

					if (!signal?.aborted) invocation.commit()

					return result
				} finally {
					invocation.release()
				}
			},
		})

	registerTool({
		name: "agent_rename",
		label: "Rename agent",
		description: "Change a subagent's display name without changing its handle.",
		exposure: "codemode",
		parameters: Type.Object({ handle: Type.String({ minLength: 1 }), name: nameParameter }),
		outputSchema: Type.Object({ handle: Type.String(), name: Type.String() }),
		async execute(_id, params, _signal, _update, ctx) {
			const run = ownedRun({
				handle: runHandleSchema.parse(params.handle),
				parentSessionId: sessionIdSchema.parse(ctx.sessionManager.getSessionId()),
			})

			const name = normalizeRunName(params.name)
			const updated = updateMetadata(runDirectory(run.handle, run.parentSessionId), { name })

			if (!updated) throw new Error(`Could not rename subagent: ${run.handle}`)

			return toolResult({ handle: run.handle, name }, `Renamed ${runDisplayName(updated)}`)
		},
	})

	registerTool({
		name: "agent_list",
		label: "List agents",
		description:
			"List subagents spawned by this session, including exited children. Set includeStopped to discover retained histories. Failed status queries return unknown with an error; other children are still listed.",
		promptGuidelines: [
			"Use agent_list to rediscover children and their handles, names, and current states if you no longer remember them.",
		],
		exposure: "codemode",
		parameters: Type.Object({
			includeStopped: Type.Optional(
				Type.Boolean({ description: "Include stopped children and their retained transcript paths." }),
			),
		}),
		outputSchema: listSchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const runs = await Promise.all(
				listRuns(sessionIdSchema.parse(ctx.sessionManager.getSessionId()), params).map(async (run) => {
					const item: Static<typeof listSchema>["runs"][number] = {
						handle: run.handle,
						blockId: run.blockId,
						sessionFile: run.sessionFile,
						cwd: run.cwd,
						model: { provider: run.provider, id: run.model },
						thinking: run.thinking,
						...(await displayStatus(exec, run, signal)),
					}

					if (run.name !== undefined) item.name = run.name

					if (run.stoppedAt !== undefined) item.stoppedAt = run.stoppedAt

					return item
				}),
			)

			const text = runs
				.map(
					(run) =>
						`${runDisplayName(run)}  ${run.state.padEnd(8)}  ${run.model.provider}/${run.model.id}  ${run.thinking}${run.error ? `  ${run.error}` : ""}`,
				)
				.join("\n")

			return toolResult({ runs }, text || "No subagents")
		},
	})

	registerTool({
		name: "agent_spawn",
		label: "Spawn agent",
		description:
			"Launch a persistent private child in Pi's Rex window. Waits for a result by default. Background completion wakes an idle parent. Busy parents receive it at the next steering opportunity.",
		promptGuidelines: [
			"Spawning for one-off work is fine. Read the result, then stop the child when no follow-up work is needed.",
			"Children persist after completion in either mode. A successful result does not stop the child.",
			"With background omitted or false, cancelling agent_spawn closes the child but preserves its transcript. Its 1800-second wait timeout leaves the child running.",
			"Keep an idle child alive only for planned follow-up work. It retains its history. Use subagent tools with its handle, not public session IDs, to communicate.",
			"A returned terminal result consumes its completion. Do not wait for a duplicate notice. Print results you need from codemode. Discarding a result or throwing later does not undo consumption.",
			"Children survive /reload. Parent shutdown suspends running children, and resuming the parent relaunches them with their history. Explicitly stopped children retain their files but never auto-resume.",
		],
		exposure: "codemode",
		parameters: spawnParameters,
		outputSchema: spawnSchema,
		async execute(_id, params, signal, _onUpdate, ctx, invocation) {
			const run = await spawn(exec, pi, ctx, params, signal, invocation)

			if (params.background) {
				const body: BackgroundResult = {
					handle: run.handle,
					blockId: run.blockId,
					sessionFile: run.sessionFile,
					cwd: run.cwd,
					model: { provider: run.provider, id: run.model },
				}

				if (run.name !== undefined) body.name = run.name

				return toolResult(body, `Spawned ${runDisplayName(run)}`)
			}

			try {
				return settledResult(await settle(exec, run, signal, 1800, invocation))
			} finally {
				if (signal?.aborted) await stopRun(exec, run.handle, { parentSessionId: run.parentSessionId })
			}
		},
	})

	registerTool({
		name: "agent_send",
		label: "Message agent",
		description:
			"Send private delegated input to this session's child. The message remains visible. Use its handle, not a session ID. Publication does not prove receipt or processing.",
		promptGuidelines: [
			"Idle children start a new turn with their existing history. Busy children receive steering by default; followUp: true queues another turn after the current work finishes.",
			"Answer child questions with agent_send({ handle, message }). Do not acknowledge acknowledgements. The child receives a custom message under existing parent authority, not new human input. This message bypasses input hooks.",
		],
		exposure: "codemode",
		parameters: Type.Object({
			handle: Type.String({ minLength: 1 }),
			message: Type.String({ minLength: 1 }),
			followUp: Type.Optional(Type.Boolean()),
		}),
		outputSchema: handleSchema,
		async execute(_id, params, signal, _update, ctx) {
			const identity = {
				handle: runHandleSchema.parse(params.handle),
				parentSessionId: sessionIdSchema.parse(ctx.sessionManager.getSessionId()),
			}

			let run = ownedRun(identity)
			assertNotStopped(run)
			const initial = run
			const seen = await readProcess(exec, run.blockId, signal)
			run = ownedRun(identity)
			assertNotStopped(run)

			if (
				run.blockId !== initial.blockId ||
				run.relation !== initial.relation ||
				run.childSessionId !== initial.childSessionId ||
				run.sessionFile !== initial.sessionFile
			) {
				throw new Error("Child identity changed during process inspection")
			}

			if (stopRequested(run)) throw new Error(`${run.handle} is stopping; retry agent_stop or use force: true`)

			if (!seen.alive) throw new Error(`${run.handle} is not running`)
			signal?.throwIfAborted()

			if (!delivery || !run.relation || !run.childSessionId) throw new Error("Private child delivery is not ready")
			delivery.send(run.childSessionId, params.message, params.followUp ? "followUp" : "steer", {
				kind: "family",
				relation: run.relation,
				handle: run.handle,
				direction: "delegate",
			})

			return toolResult({ handle: run.handle }, `Sent ${runDisplayName(run)}`)
		},
	})

	registerTool({
		name: "agent_wait",
		label: "Wait for agent",
		description: "Wait for a child's current work to finish and return its result. Defaults to a 1800-second timeout.",
		promptGuidelines: [
			"A completed wait does not stop the child. Read its result, then send concrete follow-up work or stop it when no longer needed.",
			"Cancelling or timing out agent_wait stops only the wait, not the child, and does not consume a completion. Stop the child explicitly to terminate it.",
			"agent_wait is for unfinished or idle children, not stopped archives. After stopping, read the retained sessionFile.",
			"An active wait defers completion notices. A returned terminal result consumes its exact completion, even if codemode discards it or fails later. Print the result when needed. A child may ask and yield; a blocked parent cannot answer immediately.",
			"The structured usage is session-cumulative, not a new charge. Per-source usage and model attribution are persisted independently in the parent session.",
		],
		exposure: "codemode",
		parameters: Type.Object({
			handle: Type.String({ minLength: 1 }),
			timeoutSec: Type.Optional(Type.Integer({ minimum: 1, default: 1800 })),
		}),
		outputSchema: runResultSchema,
		async execute(_id, params, signal, _update, ctx, invocation) {
			const run = ownedRun({
				handle: runHandleSchema.parse(params.handle),
				parentSessionId: sessionIdSchema.parse(ctx.sessionManager.getSessionId()),
			})

			invocation.reserve(run.handle)

			return settledResult(await settle(exec, run, signal, params.timeoutSec, invocation))
		},
	})

	registerTool({
		name: "agent_stop",
		label: "Stop agent",
		description:
			"Gracefully abort a child, wait for its response and usage to be saved, then close its Rex block. Set force to skip the wait and kill a stuck child. History is retained.",
		promptGuidelines: [
			"Stopping is repeatable and preserves history on disk. Use the returned sessionFile to read it.",
			"Graceful stop times out after 10 seconds without killing the child. Retry or use force: true; force can lose unsaved response usage.",
			"Explicitly stop every child when it is no longer needed; do not leave completed children running idle.",
		],
		exposure: "codemode",
		parameters: Type.Object({
			handle: Type.String({ minLength: 1 }),
			force: Type.Optional(Type.Boolean({ description: "Kill immediately without waiting for usage to be saved." })),
		}),
		outputSchema: Type.Object({ handle: Type.String(), sessionFile: Type.String() }),
		async execute(_id, params, signal, _update, ctx, invocation) {
			const identity = {
				handle: runHandleSchema.parse(params.handle),
				parentSessionId: sessionIdSchema.parse(ctx.sessionManager.getSessionId()),
			}

			ownedRun(identity)
			invocation.reserve(identity.handle)

			const run = await stopRun(exec, identity.handle, {
				parentSessionId: identity.parentSessionId,
				force: params.force,
				signal,
			})

			return toolResult(
				{ handle: run.handle, sessionFile: run.sessionFile },
				`Stopped ${runDisplayName(run)}; history retained at ${run.sessionFile}`,
			)
		},
	})
}

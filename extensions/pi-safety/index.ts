import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
	type CustomEntry,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	createBashTool,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent"
import { analyzeShellCommand } from "../shell-leash/analyze-shell"
import { describeScope, requestRemoteApproval } from "../shell-leash/approval"
import { type InvocationManifest, writeInvocationManifest } from "../shell-leash/invocation-manifest"
import { writeObservationExport } from "../shell-leash/observation-export"
import { createShellLeashObservationEnvelope, summarizeShellLeashObservations } from "../shell-leash/observation-schema"
import { describeRemoteOperationPolicy } from "../shell-leash/operation-policy"
import { readRuntimeObservations } from "../shell-leash/runtime-observation"
import { ShellLeashSession } from "../shell-leash/shell-leash-session"
import { type ShimSession, prepareShimSession } from "../shell-leash/shim-session"
import { createSandboxedBashOperations } from "./bash-launcher"
import { type SafetyConfigurationError, loadProjectSafetyConfiguration } from "./configuration"
import { type SafetySession, type SafetySessionError, createSafetySession } from "./safety-session"
import { type SnapshotId, parseSnapshotSessionId } from "./snapshot"

type SessionInitializationError =
	| { readonly kind: "configuration"; readonly cause: SafetyConfigurationError }
	| { readonly kind: "session-creation"; readonly cause: SafetySessionError }
	| { readonly kind: "session-id" }
	| { readonly kind: "run-start"; readonly cause: { readonly kind: "checkpoint-creation-in-progress" } }

type SessionInitialization =
	| { readonly kind: "not-started" }
	| { readonly kind: "ready"; readonly session: SafetySession }
	| { readonly kind: "failed"; readonly error: SessionInitializationError }

const GUARDED_TOOLS = new Set(["bash", "read", "write", "edit"])
const CHECKPOINT_ENTRY_TYPE = "pi-safety-checkpoint"
const SHELL_LEASH_OBSERVATION_ENTRY_TYPE = "shell-leash-observation"

interface CheckpointEntryData {
	readonly version: 1
	readonly snapshotId: SnapshotId
	readonly createdAt: string
}

export default function piSafety(pi: ExtensionAPI): void {
	let initialization: SessionInitialization = { kind: "not-started" }
	let recordedCheckpointId: SnapshotId | undefined
	let shimSession: ShimSession | undefined
	const pendingInvocations = new Map<string, InvocationFiles>()
	const shellLeash = new ShellLeashSession()
	const bashTool = createBashTool(process.cwd())
	pi.registerTool({
		...bashTool,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		execute: async (id, params, signal, onUpdate, _context) => {
			const invocationTool = createBashTool(process.cwd(), {
				operations: createSandboxedBashOperations(
					() => {
						if (initialization.kind !== "ready") {
							throw new Error("pi-safety: Bash sandbox requested before session initialization")
						}
						return initialization.session.seatbeltProfile()
					},
					() => ({
						PI_SAFETY_CHECKPOINT_READY: "1",
						...(initialization.kind === "ready" ? initialization.session.bashEnvironment() : {}),
						...(shimSession ? { PATH: shimSession.path } : {}),
						...(pendingInvocations.get(id) ? { SHELL_LEASH_INVOCATION: pendingInvocations.get(id)?.manifestPath } : {}),
					}),
				),
			})
			return invocationTool.execute(id, params, signal, onUpdate)
		},
	})

	pi.registerCommand("pi-safety", {
		description: "Show Pi safety status or the resolved ordered policy",
		getArgumentCompletions: (prefix) =>
			"policy".startsWith(prefix.trim())
				? [{ value: "policy", label: "policy", description: "Show ordered rules" }]
				: null,
		handler: async (args, context) => {
			if (!context.hasUI) return
			const action = args.trim()
			if (action !== "" && action !== "policy") {
				context.ui.notify("Usage: /pi-safety [policy]", "warning")
				return
			}
			switch (initialization.kind) {
				case "not-started":
					context.ui.notify("pi-safety: session initialization has not started", "warning")
					break
				case "failed":
					context.ui.notify(
						`pi-safety: initialization failed\n${formatInitializationError(initialization.error)}`,
						"error",
					)
					break
				case "ready": {
					if (action === "policy") {
						context.ui.notify(initialization.session.policyDescription(), "info")
						break
					}
					const status = initialization.session.checkpointStatus()
					context.ui.notify(
						[
							`pi-safety: checkpoint=${formatCheckpointStatus(status)}`,
							`workspace=${initialization.session.snapshotStore.workspaceRoot}`,
							`store=${initialization.session.snapshotStore.projectDirectory}`,
						].join("\n"),
						"info",
					)
					break
				}
			}
		},
	})

	pi.registerCommand("shell-leash", {
		description: "Show shell-leash status, request grants, or hidden observations",
		getArgumentCompletions: (prefix) => {
			const actions = ["status", "policy", "clear-grants", "observations", "clear-observations", "export-observations"]
			const matches = actions.filter((action) => action.startsWith(prefix.trim()))
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null
		},
		handler: async (args, context) => {
			if (!context.hasUI) return
			const input = args.trim()
			const separator = input.indexOf(" ")
			const action = (separator < 0 ? input : input.slice(0, separator)) || "status"
			const actionArgument = separator < 0 ? "" : input.slice(separator + 1).trim()
			if (action === "policy") {
				context.ui.notify(describeRemoteOperationPolicy(), "info")
				return
			}
			if (action === "clear-grants") {
				shellLeash.clearRequestLeases()
				context.ui.notify("shell-leash: request grants cleared", "info")
				return
			}
			if (action === "clear-observations") {
				pi.appendEntry(SHELL_LEASH_OBSERVATION_ENTRY_TYPE, {
					version: 1,
					kind: "cutoff",
					createdAt: new Date().toISOString(),
				})
				context.ui.notify("shell-leash: observation cutoff recorded", "info")
				return
			}
			if (action === "observations") {
				const observations = observationsAfterCutoff(context)
				context.ui.notify(summarizeShellLeashObservations(observations.map((entry) => entry.data)), "info")
				return
			}
			if (action === "export-observations") {
				if (!actionArgument) {
					context.ui.notify("Usage: /shell-leash export-observations <absolute-new-file>", "warning")
					return
				}
				const exported = await writeObservationExport(
					actionArgument,
					observationsAfterCutoff(context).map((entry) => entry.data),
				)
				context.ui.notify(
					exported.ok
						? `shell-leash: observations exported to ${actionArgument}`
						: `shell-leash: observation export failed (${exported.error.kind}): ${exported.error.message}`,
					exported.ok ? "info" : "error",
				)
				return
			}
			if (action !== "status") {
				context.ui.notify(
					"Usage: /shell-leash [status|policy|clear-grants|observations|clear-observations|export-observations <absolute-new-file>]",
					"warning",
				)
				return
			}
			const leases = shellLeash.activeRequestLeases()
			context.ui.notify(
				[
					`request=${shellLeash.currentRequestId() ?? "not-started"}`,
					`runtime-shims=${shimSession ? "enabled" : "disabled"}`,
					`request-grants=${leases.length}`,
					...leases.map((lease) => `${lease.operation} ${describeScope(lease.target)}`),
					`hidden-observations=${observationsAfterCutoff(context).length}`,
				].join("\n"),
				"info",
			)
		},
	})

	pi.on("session_start", async (_event, context) => {
		recordedCheckpointId = undefined
		shimSession = undefined
		pendingInvocations.clear()
		const projectConfiguration = loadProjectSafetyConfiguration(context.cwd)
		if (!projectConfiguration.ok) {
			initialization = { kind: "failed", error: { kind: "configuration", cause: projectConfiguration.error } }
			return
		}
		const home = process.env.HOME ?? os.homedir()
		const created = createSafetySession({
			cwd: context.cwd,
			home,
			stateHome: process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state"),
			piConfigDir: process.env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent"),
			additionalNoAccessPatterns: projectConfiguration.value.additionalNoAccessPatterns,
			privateTemp: process.env.TMPDIR ?? os.tmpdir(),
			integrationEnvironment: {
				path: process.env.PATH,
				sshAuthSock: process.env.SSH_AUTH_SOCK,
				dockerHost: process.env.DOCKER_HOST,
				dockerContext: process.env.DOCKER_CONTEXT,
			},
		})
		initialization = created.ok
			? { kind: "ready", session: created.value }
			: { kind: "failed", error: { kind: "session-creation", cause: created.error } }
		if (initialization.kind === "ready") {
			const preparedShims = await prepareShimSession({
				privateRoot: process.env.TMPDIR ?? os.tmpdir(),
				path: process.env.PATH ?? "",
				shimEntry: fileURLToPath(new URL("../shell-leash/shim.ts", import.meta.url)),
				executables: {
					bun: process.env.SHELL_LEASH_BUN_EXECUTABLE,
					git: process.env.SHELL_LEASH_GIT_EXECUTABLE,
					gh: process.env.SHELL_LEASH_GH_EXECUTABLE,
				},
			})
			if (preparedShims.ok) {
				shimSession = preparedShims.value
			} else if (context.hasUI) {
				context.ui.notify(`shell-leash: runtime shims disabled (${preparedShims.error.kind})`, "warning")
			}
		}
	})

	pi.on("before_agent_start", async (_event, context) => {
		shellLeash.beginRequest(randomUUID())
		if (initialization.kind !== "ready") return
		const sessionId = parseSnapshotSessionId(context.sessionManager.getSessionId())
		if (!sessionId.ok) {
			initialization = { kind: "failed", error: { kind: "session-id" } }
			return
		}
		const started = initialization.session.beginAgentRun({ kind: "pi-session", sessionId: sessionId.value })
		if (!started.ok) {
			initialization = { kind: "failed", error: { kind: "run-start", cause: started.error } }
		}
	})

	pi.on("session_shutdown", async () => {
		for (const invocation of pendingInvocations.values()) await cleanupInvocationFiles(invocation)
		pendingInvocations.clear()
		if (shimSession) {
			const cleanedShims = await shimSession.cleanup()
			if (!cleanedShims.ok) throw new Error(`shell-leash: shim cleanup failed (${cleanedShims.error.kind})`)
			shimSession = undefined
		}
		if (initialization.kind !== "ready") return
		const cleaned = initialization.session.cleanup()
		if (!cleaned.ok) throw new Error(`pi-safety: integration cleanup failed (${cleaned.error.kind})`)
	})

	pi.on("tool_call", async (event, context) => {
		if (!GUARDED_TOOLS.has(event.toolName)) return
		if (initialization.kind === "not-started") {
			return { block: true, reason: "pi-safety: session initialization has not completed" }
		}
		if (initialization.kind === "failed") {
			return {
				block: true,
				reason: `pi-safety: session initialization failed: ${formatInitializationError(initialization.error)}`,
			}
		}
		if (isToolCallEventType("bash", event)) {
			const remoteDecision = await authorizeRemoteBash(pi, shellLeash, event.toolCallId, event.input.command, context)
			if (remoteDecision) return remoteDecision
		}
		const decision = await initialization.session.authorize(event.toolName, event.input)
		if (decision.kind === "block") {
			shellLeash.finishToolCall(event.toolCallId)
			return { block: true, reason: decision.reason }
		}
		const checkpoint = initialization.session.checkpointStatus()
		if (checkpoint.kind === "ready" && checkpoint.snapshot.id !== recordedCheckpointId) {
			recordedCheckpointId = checkpoint.snapshot.id
			try {
				pi.appendEntry<CheckpointEntryData>(CHECKPOINT_ENTRY_TYPE, {
					version: 1,
					snapshotId: checkpoint.snapshot.id,
					createdAt: checkpoint.snapshot.createdAt,
				})
			} catch (cause) {
				if (context.hasUI) {
					context.ui.notify(
						`pi-safety: checkpoint created, but its session marker could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`,
						"warning",
					)
				}
			}
		}
		if (event.toolName === "bash" && shimSession) {
			const preparedInvocation = await prepareInvocationFiles(shellLeash, shimSession, event.toolCallId)
			if (!preparedInvocation.ok) {
				shellLeash.finishToolCall(event.toolCallId)
				return { block: true, reason: `shell-leash: invocation manifest failed: ${preparedInvocation.message}` }
			}
			pendingInvocations.set(event.toolCallId, preparedInvocation.value)
		}
		return undefined
	})

	pi.on("tool_result", async (event, context) => {
		if (event.toolName !== "bash") return
		const invocation = pendingInvocations.get(event.toolCallId)
		if (invocation) {
			try {
				const runtimeObservations = await readRuntimeObservations(invocation.observationLog)
				if (runtimeObservations.ok) {
					for (const entry of runtimeObservations.value) {
						appendShellLeashEntrySafely(
							pi,
							createShellLeashObservationEnvelope({
								requestId: invocation.requestId,
								toolCallId: event.toolCallId,
								createdAt: entry.createdAt,
								cwd: context.cwd,
								source: { kind: "runtime", argv: entry.argv },
								observation: entry.observation,
							}),
							context,
						)
					}
				} else {
					appendShellLeashEntrySafely(
						pi,
						createShellLeashObservationEnvelope({
							requestId: invocation.requestId,
							toolCallId: event.toolCallId,
							cwd: context.cwd,
							source: { kind: "runtime", argv: [] },
							observation: {
								kind: "runtime-log-error",
								errorKind: runtimeObservations.error.kind,
								message: runtimeObservations.error.message,
							},
						}),
						context,
					)
				}
			} finally {
				try {
					await cleanupInvocationFiles(invocation)
				} catch (cause) {
					if (context.hasUI)
						context.ui.notify(`shell-leash: invocation cleanup failed: ${errorMessage(cause)}`, "warning")
				}
				pendingInvocations.delete(event.toolCallId)
			}
		}
		shellLeash.finishToolCall(event.toolCallId)
	})
}

type InvocationFiles = { readonly requestId: string; readonly manifestPath: string; readonly observationLog: string }

async function prepareInvocationFiles(
	session: ShellLeashSession,
	shims: ShimSession,
	toolCallId: string,
): Promise<{ readonly ok: true; readonly value: InvocationFiles } | { readonly ok: false; readonly message: string }> {
	const authorization = session.authorizationSnapshot(toolCallId)
	const nonce = randomUUID()
	const files = {
		requestId: authorization.requestId,
		manifestPath: path.join(shims.root, `invocation-${nonce}.json`),
		observationLog: path.join(shims.root, `observations-${nonce}.jsonl`),
	}
	const createdAt = new Date()
	const manifest: InvocationManifest = {
		version: 1,
		requestId: authorization.requestId,
		toolCallId,
		createdAt: createdAt.toISOString(),
		expiresAt: new Date(createdAt.getTime() + 60 * 60 * 1000).toISOString(),
		realExecutables: shims.realExecutables,
		observationLog: files.observationLog,
		permit: authorization.permit,
		leases: authorization.leases,
	}
	const written = await writeInvocationManifest(files.manifestPath, manifest)
	return written.ok ? { ok: true, value: files } : { ok: false, message: written.error.message }
}

async function cleanupInvocationFiles(files: InvocationFiles): Promise<void> {
	await Promise.all([rm(files.manifestPath, { force: true }), rm(files.observationLog, { force: true })])
}

async function authorizeRemoteBash(
	pi: ExtensionAPI,
	session: ShellLeashSession,
	toolCallId: string,
	command: string,
	context: ExtensionContext,
): Promise<{ readonly block: true; readonly reason: string } | undefined> {
	const analysis = await analyzeShellCommand({
		source: command,
		cwd: context.cwd,
		environment: {
			GH_REPO: process.env.GH_REPO,
			GIT_DIR: process.env.GIT_DIR,
			GIT_WORK_TREE: process.env.GIT_WORK_TREE,
		},
	})
	for (const observation of analysis.observations) {
		try {
			pi.appendEntry(
				SHELL_LEASH_OBSERVATION_ENTRY_TYPE,
				createShellLeashObservationEnvelope({
					requestId: session.currentRequestId() ?? "not-started",
					toolCallId,
					cwd: context.cwd,
					source: { kind: "static", command },
					observation,
				}),
			)
		} catch (cause) {
			if (context.hasUI) {
				context.ui.notify(
					`shell-leash: could not save analysis observation: ${cause instanceof Error ? cause.message : String(cause)}`,
					"warning",
				)
			}
		}
	}
	if (analysis.findings.length === 0) return undefined
	const decision = session.review(toolCallId, analysis.findings)
	if (decision.kind === "allow") return undefined
	if (!context.hasUI) {
		return { block: true, reason: "shell-leash: approval requires an interactive session" }
	}

	const approval = await requestRemoteApproval(decision.findings, (prompt, options) =>
		context.ui.select(prompt, options),
	)
	if (approval.kind === "allow-once") {
		session.allowOnce(toolCallId, decision.findings)
		return undefined
	}
	if (approval.kind === "allow-request") {
		for (const grant of approval.grants) session.allowForRequest(grant.finding.effect.operation, grant.scope)
		session.allowOnce(toolCallId, decision.findings)
		return undefined
	}
	return {
		block: true,
		reason: `shell-leash: denied ${[...new Set(decision.findings.map((finding) => finding.effect.operation))].join(", ")}`,
	}
}

function appendShellLeashEntrySafely(
	pi: ExtensionAPI,
	data: ReturnType<typeof createShellLeashObservationEnvelope>,
	context: ExtensionContext,
): void {
	try {
		pi.appendEntry(SHELL_LEASH_OBSERVATION_ENTRY_TYPE, data)
	} catch (cause) {
		if (context.hasUI)
			context.ui.notify(`shell-leash: could not save runtime observation: ${errorMessage(cause)}`, "warning")
	}
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause)
}

function observationsAfterCutoff(context: ExtensionContext) {
	const observations = context.sessionManager.getBranch().filter(isShellLeashObservation)
	let cutoff = -1
	for (let index = 0; index < observations.length; index++) {
		const data = observations[index]?.data
		if (data && typeof data === "object" && "kind" in data && data.kind === "cutoff") cutoff = index
	}
	return observations.slice(cutoff + 1)
}

function isShellLeashObservation(entry: SessionEntry): entry is CustomEntry {
	return entry.type === "custom" && entry.customType === SHELL_LEASH_OBSERVATION_ENTRY_TYPE
}

function formatInitializationError(error: SessionInitializationError): string {
	switch (error.kind) {
		case "configuration":
			return `${error.cause.path}: ${error.cause.message}`
		case "session-creation":
			return JSON.stringify(error.cause)
		case "session-id":
			return "Pi returned an invalid session identifier"
		case "run-start":
			return "cannot start a new run while checkpoint creation is in progress"
	}
}

function formatCheckpointStatus(status: ReturnType<SafetySession["checkpointStatus"]>): string {
	switch (status.kind) {
		case "run-not-started":
		case "not-started":
		case "creating":
			return status.kind
		case "ready":
			return `ready (${status.snapshot.id})`
		case "failed":
			return `failed (${JSON.stringify(status.error)})`
	}
}

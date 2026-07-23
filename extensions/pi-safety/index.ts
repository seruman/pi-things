import * as os from "node:os"
import * as path from "node:path"
import { type ExtensionAPI, type ExtensionContext, createBashTool } from "@earendil-works/pi-coding-agent"
import { createSandboxedBashOperations } from "./bash-launcher"
import { type SafetyConfigurationError, loadProjectSafetyConfiguration } from "./configuration"
import { type SafetySession, type SafetySessionError, createSafetySession } from "./safety-session"
import { showPiSafetySettings } from "./safety-settings"
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
const PROTECTION_STATUS_KEY = "pi-safety-protection"

interface CheckpointEntryData {
	readonly version: 1
	readonly snapshotId: SnapshotId
	readonly createdAt: string
}

export default function piSafety(pi: ExtensionAPI): void {
	let initialization: SessionInitialization = { kind: "not-started" }
	let recordedCheckpointId: SnapshotId | undefined
	const features = { protection: false, checkpoints: true }
	const bashTool = createBashTool(process.cwd())
	pi.registerTool({
		...bashTool,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		execute: async (id, params, signal, onUpdate, _context) => {
			const environment = () => ({
				PI_SAFETY_CHECKPOINT_READY: "1",
				...(initialization.kind === "ready" ? initialization.session.bashEnvironment() : {}),
			})
			const invocationTool = features.protection
				? createBashTool(process.cwd(), {
						operations: createSandboxedBashOperations(() => {
							if (initialization.kind !== "ready") {
								throw new Error("pi-safety: Bash sandbox requested before session initialization")
							}
							return initialization.session.seatbeltProfile()
						}, environment),
					})
				: createBashTool(process.cwd(), {
						shellPath: "/bin/bash",
						spawnHook: (context) => ({ ...context, env: { ...context.env, ...environment() } }),
					})
			return invocationTool.execute(id, params, signal, onUpdate)
		},
	})

	pi.registerCommand("pi-safety", {
		description: "Manage Pi Safety for this session or inspect its policy",
		getArgumentCompletions: (prefix) => {
			const query = prefix.trim()
			const actions = [
				{ value: "add", label: "add", description: "Add a session directory" },
				{ value: "remove", label: "remove", description: "Remove a session directory" },
				{ value: "status", label: "status", description: "Show current status" },
				{ value: "policy", label: "policy", description: "Show ordered rules" },
			]
			const matches = actions.filter((action) => action.value.startsWith(query))
			return matches.length > 0 ? matches : null
		},
		handler: async (args, context) => {
			if (!context.hasUI) return
			const [action, pathArgument] = splitCommandArguments(args)
			if (action !== "" && action !== "add" && action !== "remove" && action !== "status" && action !== "policy") {
				context.ui.notify("Usage: /pi-safety [add [path]|remove [path]|status|policy]", "warning")
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
					if (action === "add") {
						await addSessionPath(context, initialization.session, pathArgument)
						break
					}
					if (action === "remove") {
						await removeSessionPath(context, initialization.session, pathArgument)
						break
					}
					if (action === "policy") {
						context.ui.notify(initialization.session.policyDescription(), "info")
						break
					}
					const statusLines = piSafetyStatusLines(initialization.session, features.protection, features.checkpoints)
					if (action === "status") {
						context.ui.notify(`pi-safety: ${statusLines.join("\n")}`, "info")
						break
					}
					const changed = await showPiSafetySettings(context, features.protection, features.checkpoints, statusLines)
					if (!changed) break
					features[changed.feature] = changed.enabled
					if (changed.feature === "protection") updateProtectionStatus(context, changed.enabled)
					const label = changed.feature === "protection" ? "filesystem protection" : "APFS checkpoints"
					context.ui.notify(
						`pi-safety: ${label} ${changed.enabled ? "enabled" : "disabled"}`,
						changed.enabled ? "info" : "warning",
					)
					break
				}
			}
		},
	})

	pi.on("session_start", async (_event, context) => {
		recordedCheckpointId = undefined
		features.protection = process.env.PI_SAFETY_PROTECTION === "1"
		features.checkpoints = true
		if (context.hasUI) updateProtectionStatus(context, features.protection)
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
			gopath: process.env.GOPATH,
			privateTemp: process.env.TMPDIR ?? os.tmpdir(),
			sessionPathsEnvironment: process.env.PI_SAFETY_SESSION_PATHS,
			integrationEnvironment: {
				path: process.env.PATH,
				sshAuthSock: process.env.SSH_AUTH_SOCK,
				dockerHost: process.env.DOCKER_HOST,
				dockerContext: process.env.DOCKER_CONTEXT,
				xdgCacheHome: process.env.XDG_CACHE_HOME,
				nixRemote: process.env.NIX_REMOTE,
			},
		})
		initialization = created.ok
			? { kind: "ready", session: created.value }
			: { kind: "failed", error: { kind: "session-creation", cause: created.error } }
	})

	pi.on("before_agent_start", async (_event, context) => {
		if (initialization.kind !== "ready" || !features.checkpoints) return
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

	pi.on("session_shutdown", async (_event, context) => {
		if (context.hasUI) context.ui.setStatus(PROTECTION_STATUS_KEY, undefined)
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
		if (features.protection) {
			const guard = initialization.session.guard(event.toolName, event.input)
			if (guard.kind === "block") return { block: true, reason: guard.reason }
		}
		if (features.checkpoints) {
			const checkpointDecision = await initialization.session.checkpoint(event.toolName)
			if (checkpointDecision.kind === "block") return { block: true, reason: checkpointDecision.reason }
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
		return undefined
	})
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

function piSafetyStatusLines(session: SafetySession, protection: boolean, checkpoints: boolean): readonly string[] {
	return [
		`protection=${protection ? "enabled" : "disabled"}`,
		`checkpoints=${checkpoints ? `enabled · ${formatCheckpointStatus(session.checkpointStatus())}` : "disabled"}`,
		`workspace=${session.snapshotStore.workspaceRoot}`,
		`store=${session.snapshotStore.projectDirectory}`,
		...session
			.sessionPaths()
			.map(
				(grant) =>
					`session-path=${grant.access} · ${grant.path}${grant.access === "read-write" ? " · not checkpointed" : ""}`,
			),
	]
}

function splitCommandArguments(input: string): readonly [string, string] {
	const trimmed = input.trim()
	const separator = trimmed.search(/\s/)
	return separator < 0 ? [trimmed, ""] : [trimmed.slice(0, separator), trimmed.slice(separator).trim()]
}

async function addSessionPath(context: ExtensionContext, session: SafetySession, argument: string): Promise<void> {
	const pathname = argument || (await context.ui.input("Add Pi Safety session directory", "Absolute path or ~/path"))
	if (!pathname) return
	const choice = await context.ui.select("Directory access", ["Read-only", "Read-write — not checkpointed", "Cancel"])
	if (!choice || choice === "Cancel") return
	const access = choice === "Read-only" ? "read-only" : "read-write"
	const confirmed = await context.ui.confirm(
		`Add ${access} session directory?`,
		`${pathname}\n\n${access === "read-write" ? "Writes are not included in Pi Safety checkpoints. " : ""}Protected paths remain inaccessible.`,
	)
	if (!confirmed) return
	const added = session.addSessionPath(pathname, access)
	if (!added.ok) {
		context.ui.notify(`pi-safety: could not add session directory: ${JSON.stringify(added.error)}`, "error")
		return
	}
	context.ui.notify(`pi-safety: added ${access} session directory ${added.value.path}`, "info")
}

async function removeSessionPath(context: ExtensionContext, session: SafetySession, argument: string): Promise<void> {
	const grants = session.sessionPaths()
	const pathname =
		argument ||
		(await context.ui.select(
			"Remove Pi Safety session directory",
			grants.map((grant) => grant.path),
		))
	if (!pathname) return
	const removed = session.removeSessionPath(pathname)
	if (!removed.ok) {
		context.ui.notify(`pi-safety: could not remove session directory: ${JSON.stringify(removed.error)}`, "error")
		return
	}
	context.ui.notify(
		removed.value
			? `pi-safety: removed session directory ${pathname}`
			: `pi-safety: no session directory matched ${pathname}`,
		removed.value ? "info" : "warning",
	)
}

function updateProtectionStatus(context: ExtensionContext, enabled: boolean): void {
	context.ui.setStatus(
		PROTECTION_STATUS_KEY,
		enabled ? context.ui.theme.fg("accent", "Filesystem protection enabled") : undefined,
	)
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

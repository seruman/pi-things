import * as os from "node:os"
import * as path from "node:path"
import { type ExtensionAPI, createBashTool } from "@earendil-works/pi-coding-agent"
import { createSandboxedBashOperations } from "./bash-launcher"
import { type SafetyConfigurationError, loadProjectSafetyConfiguration } from "./configuration"
import { type SafetySession, type SafetySessionError, createSafetySession } from "./safety-session"

type SessionInitializationError =
	| { readonly kind: "configuration"; readonly cause: SafetyConfigurationError }
	| { readonly kind: "session-creation"; readonly cause: SafetySessionError }
	| { readonly kind: "run-start"; readonly cause: { readonly kind: "checkpoint-creation-in-progress" } }

type SessionInitialization =
	| { readonly kind: "not-started" }
	| { readonly kind: "ready"; readonly session: SafetySession }
	| { readonly kind: "failed"; readonly error: SessionInitializationError }

const GUARDED_TOOLS = new Set(["bash", "read", "write", "edit"])

export default function piSafety(pi: ExtensionAPI): void {
	let initialization: SessionInitialization = { kind: "not-started" }
	const bashTool = createBashTool(process.cwd(), {
		operations: createSandboxedBashOperations(
			() => {
				if (initialization.kind !== "ready") {
					throw new Error("pi-safety: Bash sandbox requested before session initialization")
				}
				return initialization.session.compileBashProfile()
			},
			() => ({
				PI_SAFETY_CHECKPOINT_READY: "1",
				...(initialization.kind === "ready" ? initialization.session.bashEnvironment() : {}),
			}),
		),
	})
	pi.registerTool({
		...bashTool,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		execute: async (id, params, signal, onUpdate, _context) => bashTool.execute(id, params, signal, onUpdate),
	})

	pi.registerCommand("pi-safety", {
		description: "Show Pi safety initialization and checkpoint status",
		handler: async (_args, context) => {
			if (!context.hasUI) return
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

	pi.on("session_start", async (_event, context) => {
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
			additionalSecretPatterns: projectConfiguration.value.additionalSecretPatterns,
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
	})

	pi.on("before_agent_start", async () => {
		if (initialization.kind !== "ready") return
		const started = initialization.session.beginAgentRun()
		if (!started.ok) {
			initialization = { kind: "failed", error: { kind: "run-start", cause: started.error } }
		}
	})

	pi.on("session_shutdown", async () => {
		if (initialization.kind !== "ready") return
		const cleaned = initialization.session.cleanup()
		if (!cleaned.ok) throw new Error(`pi-safety: integration cleanup failed (${cleaned.error.kind})`)
	})

	pi.on("tool_call", async (event) => {
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
		const decision = await initialization.session.authorize(event.toolName, event.input)
		return decision.kind === "allow" ? undefined : { block: true, reason: decision.reason }
	})
}

function formatInitializationError(error: SessionInitializationError): string {
	switch (error.kind) {
		case "configuration":
			return `${error.cause.path}: ${error.cause.message}`
		case "session-creation":
			return JSON.stringify(error.cause)
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

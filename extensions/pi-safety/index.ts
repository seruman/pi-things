import * as os from "node:os"
import * as path from "node:path"
import {
	type ExtensionAPI,
	type ExtensionContext,
	createBashToolDefinition,
	getAgentDir,
} from "@earendil-works/pi-coding-agent"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { createSandboxedBashOperations } from "./bash-launcher"
import { type SafetyConfigurationError, loadProjectSafetyConfiguration } from "./configuration"
import { type SafetySession, type SafetySessionError, createSafetySession } from "./safety-session"
import { showPiSafetySettings } from "./safety-settings"

type SessionInitializationError =
	| { readonly kind: "configuration"; readonly cause: SafetyConfigurationError }
	| { readonly kind: "session-creation"; readonly cause: SafetySessionError }

type SessionInitialization =
	| { readonly kind: "not-started" }
	| { readonly kind: "ready"; readonly session: SafetySession }
	| { readonly kind: "failed"; readonly error: SessionInitializationError }

const GUARDED_TOOLS = new Set(["bash", "read", "write", "edit"])

export default function piSafety(pi: ExtensionAPI): void {
	let initialization: SessionInitialization = { kind: "not-started" }
	let protection = false
	let bashWrapperRegistered = false

	const registerBashWrapper = (context: ExtensionContext): void => {
		if (bashWrapperRegistered) return

		if (!pi.getAllTools().some((tool) => tool.name === "bash")) return
		bashWrapperRegistered = true
		const bashTool = createBashToolDefinition(context.cwd)
		pi.registerTool({
			...bashTool,
			execute: async (id, params, signal, onUpdate, toolContext) => {
				const cwd = toolContext.cwd

				const environment = () => (initialization.kind === "ready" ? initialization.session.bashEnvironment() : {})

				const invocationTool = protection
					? createBashToolDefinition(cwd, {
							operations: createSandboxedBashOperations(() => {
								if (initialization.kind !== "ready") {
									throw new Error("pi-safety: Bash sandbox requested before session initialization")
								}

								return initialization.session.seatbeltProfile()
							}, environment),
						})
					: createBashToolDefinition(cwd, {
							shellPath: "/bin/bash",
							spawnHook: (context) => ({ ...context, env: { ...context.env, ...environment() } }),
						})

				return invocationTool.execute(id, params, signal, onUpdate, toolContext)
			},
		})
	}

	pi.on("session_start", (_event, context) => registerBashWrapper(context))

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

					const session = initialization.session

					if (action === "status") {
						const statusLines = piSafetyStatusLines(session, protection)
						context.ui.notify(`pi-safety: ${statusLines.join("\n")}`, "info")
						break
					}

					await showPiSafetySettings(context, protection, session.seatbeltPolicy(), (enabled) => {
						protection = enabled
						updateSeatbeltFooter(pi, context, enabled)
					})
					break
				}
			}
		},
	})

	pi.on("session_start", async (_event, context) => {
		protection = process.env.PI_SAFETY_PROTECTION === "1"

		if (context.mode === "tui") updateSeatbeltFooter(pi, context, protection)
		const projectConfiguration = loadProjectSafetyConfiguration(context.cwd)

		if (!projectConfiguration.ok) {
			initialization = { kind: "failed", error: { kind: "configuration", cause: projectConfiguration.error } }

			return
		}

		const home = process.env.HOME ?? os.homedir()

		const created = createSafetySession({
			cwd: context.cwd,
			home,
			piConfigDir: getAgentDir(),
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

	pi.on("session_shutdown", async (_event, context) => {
		if (context.mode === "tui") context.ui.setFooter(undefined)

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

		if (protection) {
			const guard = initialization.session.guard(event.toolName, event.input)

			if (guard.kind === "block") return { block: true, reason: guard.reason }
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
	}
}

function piSafetyStatusLines(session: SafetySession, protection: boolean): readonly string[] {
	return [
		`seatbelt=${protection ? "enabled" : "disabled"}`,
		...session.sessionPaths().map((grant) => `session-path=${grant.access} · ${grant.path}`),
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
	const choice = await context.ui.select("Directory access", ["Read-only", "Read-write", "Cancel"])

	if (!choice || choice === "Cancel") return
	const access = choice === "Read-only" ? "read-only" : "read-write"

	const confirmed = await context.ui.confirm(
		`Add ${access} session directory?`,
		`${pathname}\n\nProtected paths remain inaccessible.`,
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

function updateSeatbeltFooter(pi: ExtensionAPI, context: ExtensionContext, enabled: boolean): void {
	if (context.mode !== "tui") return

	if (!enabled) {
		context.ui.setFooter(undefined)

		return
	}

	context.ui.setFooter((tui, theme, footerData) => {
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender())

		return {
			dispose: unsubscribe,
			invalidate: () => {},
			render: (width: number) => {
				if (width <= 0) return ["", ""]
				const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
				let cacheHit: number | undefined

				for (const entry of context.sessionManager.getEntries()) {
					const usage =
						entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary"
							? entry.usage
							: entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")
								? entry.message.usage
								: undefined

					if (!usage) continue
					totals.input += usage.input
					totals.output += usage.output
					totals.cacheRead += usage.cacheRead
					totals.cacheWrite += usage.cacheWrite
					totals.cost += usage.cost.total

					if (entry.type === "message" && entry.message.role === "assistant") {
						const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite
						cacheHit = promptTokens > 0 ? (100 * usage.cacheRead) / promptTokens : undefined
					}
				}

				const home = process.env.HOME ?? os.homedir()
				const relative = path.relative(home, context.cwd)

				const insideHome =
					relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))

				let cwd = insideHome ? (relative ? `~${path.sep}${relative}` : "~") : context.cwd
				const branch = footerData.getGitBranch()

				if (branch) cwd += ` (${branch})`
				const sessionName = context.sessionManager.getSessionName()

				if (sessionName) cwd += ` • ${sessionName}`
				const stats: string[] = []

				if (totals.input) stats.push(`↑${formatFooterTokens(totals.input)}`)

				if (totals.output) stats.push(`↓${formatFooterTokens(totals.output)}`)

				if (totals.cacheRead) stats.push(`R${formatFooterTokens(totals.cacheRead)}`)

				if (totals.cacheWrite) stats.push(`W${formatFooterTokens(totals.cacheWrite)}`)

				if ((totals.cacheRead || totals.cacheWrite) && cacheHit !== undefined) stats.push(`CH${cacheHit.toFixed(1)}%`)

				const subscription =
					context.model &&
					context.modelRegistry.isUsingOAuth(context.model) &&
					context.modelRegistry.getProvider(context.model.provider)?.auth.oauth?.isSubscription === true

				if (totals.cost || subscription) stats.push(`$${totals.cost.toFixed(3)}${subscription ? " (sub)" : ""}`)
				const usage = context.getContextUsage()
				const percent = usage?.percent
				const contextText = `${percent == null ? "?" : `${percent.toFixed(1)}%`}/${formatFooterTokens(usage?.contextWindow ?? context.model?.contextWindow ?? 0)}`

				const contextColor =
					percent != null && percent > 90 ? "error" : percent != null && percent > 70 ? "warning" : "dim"

				const left =
					theme.fg("accent", "Seatbelt enabled") +
					theme.fg("dim", ` · ${stats.join(" ")}${stats.length ? " " : ""}`) +
					theme.fg(contextColor, contextText)

				let right = context.model?.id ?? "no-model"

				if (context.model?.reasoning) right += ` • ${context.thinkingLevel ?? pi.getThinkingLevel()}`

				if (context.model && footerData.getAvailableProviderCount() > 1) {
					const withProvider = `(${context.model.provider}) ${right}`

					if (visibleWidth(left) + 2 + visibleWidth(withProvider) <= width) right = withProvider
				}

				const available = width - visibleWidth(left) - 2
				const modelText = available > 0 ? truncateToWidth(theme.fg("dim", right), available, "") : ""
				const padding = modelText ? " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(modelText))) : ""

				const lines = [
					truncateToWidth(theme.fg("dim", cwd), width, ""),
					truncateToWidth(left + padding + modelText, width, ""),
				]

				const statuses = [...footerData.getExtensionStatuses()].sort(([a], [b]) => a.localeCompare(b))

				if (statuses.length) {
					lines.push(
						truncateToWidth(
							statuses
								.map(([, text]) =>
									text
										.replace(/[\r\n\t]/g, " ")
										.replace(/ +/g, " ")
										.trim(),
								)
								.join(" "),
							width,
							"",
						),
					)
				}

				return lines
			},
		}
	})
}

function formatFooterTokens(count: number): string {
	if (count < 1000) return String(count)

	if (count < 10000) return `${(count / 1000).toFixed(1)}k`

	if (count < 1000000) return `${Math.round(count / 1000)}k`

	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`

	return `${Math.round(count / 1000000)}M`
}

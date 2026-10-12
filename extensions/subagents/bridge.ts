import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { type RunMetadata, inboxDir, inboxMessageSchema, readMetadata, updateMetadata } from "./runs"

export type BridgeContext = Pick<ExtensionContext, "isIdle"> & {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getSessionFile">
}

export type LifecycleEvent = { type: string; reason?: string }

export type BridgeHandler = (event: LifecycleEvent, ctx: BridgeContext) => void | Promise<void>

export interface BridgeAPI {
	on(event: "session_start" | "agent_start" | "agent_settled" | "session_shutdown", handler: BridgeHandler): void
	setSessionName: ExtensionAPI["setSessionName"]
	sendUserMessage(message: string, options?: { deliverAs?: "steer" | "followUp" }): void
}

export function installBridge(pi: BridgeAPI, runDir: string): void {
	let current: BridgeContext | undefined
	let timer: ReturnType<typeof setInterval> | undefined
	let processing = false
	let sessionName: string | undefined
	let sessionPending = true
	let hasStarted = false

	// Unlike tmux, Rex assigns the block id at launch, so metadata can arrive after session_start.
	const initializeSession = (): boolean => {
		if (!current) return false

		if (!sessionPending) return true
		const metadata = readMetadata(runDir)

		if (!metadata) return false

		const patch: Partial<RunMetadata> = {
			childSessionId: current.sessionManager.getSessionId(),
			sessionFile: current.sessionManager.getSessionFile() ?? metadata.sessionFile,
			state: current.isIdle() ? "idle" : "busy",
			suspended: undefined,
			error: undefined,
		}

		if (hasStarted) patch.hasStarted = true
		const updated = updateMetadata(runDir, patch)

		if (!updated) return false
		sessionPending = false

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

	// Upstream inbox processing with Zod validation.
	const processInbox = (): void => {
		if (processing || !current || !initializeSession()) return
		syncSessionName()
		const directory = inboxDir(runDir)

		if (!existsSync(directory)) return
		processing = true

		try {
			for (const name of readdirSync(directory)
				.filter((entry) => entry.endsWith(".json"))
				.sort()) {
				const path = join(directory, name)
				let payload: ReturnType<typeof inboxMessageSchema.parse>

				try {
					payload = inboxMessageSchema.parse(JSON.parse(readFileSync(path, "utf8")))
				} catch (error) {
					unlinkSync(path)
					updateMetadata(runDir, { state: "error", error: error instanceof Error ? error.message : String(error) })
					continue
				}

				updateMetadata(runDir, { state: "busy", error: undefined })

				try {
					if (current.isIdle()) {
						pi.sendUserMessage(payload.message)
					} else {
						pi.sendUserMessage(payload.message, {
							deliverAs: payload.delivery === "followUp" ? "followUp" : "steer",
						})
					}

					unlinkSync(path)
				} catch (error) {
					updateMetadata(runDir, {
						state: current.isIdle() ? "idle" : "busy",
						error: error instanceof Error ? error.message : String(error),
					})

					return
				}
			}
		} finally {
			processing = false
		}
	}

	pi.on("session_start", (_event, ctx) => {
		current = ctx
		sessionPending = true

		if (!timer) {
			// Rex may start the child before the parent has written its metadata.
			timer = setInterval(processInbox, 250)
			timer.unref()
		}

		processInbox()
	})

	pi.on("agent_start", (_event, ctx) => {
		current = ctx
		hasStarted = true
		updateMetadata(runDir, { state: "busy", hasStarted: true, error: undefined })
	})

	pi.on("agent_settled", (_event, ctx) => {
		current = ctx

		if (ctx.isIdle()) updateMetadata(runDir, { state: "idle" })
	})

	pi.on("session_shutdown", (event) => {
		current = undefined

		if (timer) {
			clearInterval(timer)
			timer = undefined
		}

		if (event.reason === "quit") updateMetadata(runDir, { state: "exited" })
	})
}

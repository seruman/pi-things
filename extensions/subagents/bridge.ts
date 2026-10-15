import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { onShellLeashDenial } from "../shell-leash/denial"
import type { BridgeContext, BridgeHost } from "./contracts"
import { type RunMetadata, inboxDir, inboxMessageSchema, readMetadata, updateMetadata } from "./runs"

export function installBridge(pi: BridgeHost, runDir: string): void {
	let current: BridgeContext | undefined
	let timer: ReturnType<typeof setInterval> | undefined
	let processing = false
	let sessionName: string | undefined
	let sessionPending = true
	let hasStarted = false
	let denial: string | undefined

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

		const patch: Partial<RunMetadata> = {
			sessionFiles: [...new Set([...(metadata.sessionFiles ?? []), metadata.sessionFile, sessionFile])],
			childSessionId: current.sessionManager.getSessionId(),
			sessionFile,
			state: current.isIdle() ? "idle" : "busy",
		}

		if (hasStarted) patch.hasStarted = true

		if (denial && current.isIdle()) {
			patch.state = "error"
			patch.error = denial
		}

		const updated = updateMetadata(runDir, patch, patch.error ? ["suspended"] : ["suspended", "error"])

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

				updateMetadata(runDir, { state: "busy" }, ["error"])

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
		denial = undefined

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
		denial = undefined
		updateMetadata(runDir, { state: "busy", hasStarted: true }, ["error"])
	})

	pi.on("agent_settled", (_event, ctx) => {
		current = ctx

		if (ctx.isIdle()) {
			// Publish only after cancellation settles, not while sibling tools may still be running.
			updateMetadata(runDir, denial ? { state: "error", error: denial } : { state: "idle" })
		}
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

import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { z } from "zod"
import { resolveRexSession } from "../lib/rex"
import { type Exec, readProcess } from "./rex"

type ProcessStatus = Awaited<ReturnType<typeof readProcess>>

export type WatchRexEvents = (session: string, onLine: (line: string) => void, onDisconnect: () => void) => () => void

const watchRexEvents: WatchRexEvents = (session, onLine, onDisconnect) => {
	const child = spawn("rex", ["events", "-s", session, "--json"], { stdio: ["ignore", "pipe", "ignore"] })
	const lines = createInterface({ input: child.stdout! })
	let closed = false

	const disconnect = () => {
		if (closed) return
		closed = true
		lines.close()
		onDisconnect()
	}

	lines.on("line", onLine)
	child.once("error", disconnect)
	child.once("close", disconnect)

	return () => {
		closed = true
		lines.close()
		child.kill()
	}
}

// Verified against rex events --json. Ignore all data except events for tracked blocks.
const eventSchema = z.object({
	type: z.literal("session_event"),
	payload: z.object({
		session_id: z.string(),
		event: z.object({
			type: z.string(),
			payload: z.object({ block_id: z.string(), name: z.string().optional() }),
		}),
	}),
})

interface Observation {
	version: number
	value?: ProcessStatus
	checkedAt?: number
}

/** Observation cache only. Mutating tools still inspect Rex directly before acting. */
export class RexLiveness {
	private readonly observations = new Map<string, Observation>()
	private active = false
	private healthy = false
	private generation = 0
	private disconnect?: () => void
	private retry?: ReturnType<typeof setTimeout>
	private retryDelay = 1000
	private block?: string
	private onChange: () => void = () => {}

	constructor(
		private readonly exec: Exec,
		private readonly watch: WatchRexEvents = watchRexEvents,
	) {}

	async start(onChange: () => void): Promise<void> {
		this.stop()
		this.block = process.env.REX_BLOCK?.trim()

		if (!this.block) return
		this.active = true
		this.onChange = onChange
		await this.connect()
	}

	private async connect(): Promise<void> {
		if (!this.active || !this.block) return
		const generation = ++this.generation

		const disconnected = () => {
			if (!this.active || generation !== this.generation) return
			this.generation++
			this.disconnect?.()
			this.disconnect = undefined
			this.healthy = false
			this.observations.clear()
			this.onChange()
			this.retry = setTimeout(() => void this.connect(), this.retryDelay)
			this.retry.unref()
			this.retryDelay = Math.min(this.retryDelay * 2, 30_000)
		}

		try {
			const session = await resolveRexSession(this.exec, this.block)

			if (!this.active || generation !== this.generation) return
			this.disconnect = this.watch(
				session,
				(line) => {
					if (!this.active || generation !== this.generation) return
					let parsed: ReturnType<typeof eventSchema.safeParse>

					try {
						parsed = eventSchema.safeParse(JSON.parse(line))
					} catch {
						return
					}

					if (!parsed.success || parsed.data.payload.session_id !== session) return
					this.healthy = true
					this.retryDelay = 1000
					const event = parsed.data.payload.event
					const observation = this.observations.get(event.payload.block_id)

					if (!observation) return

					if (event.type === "block_closed") {
						observation.value = { exists: false, alive: false }
					} else if (event.type === "block_event" && event.payload.name === "child_exited") {
						observation.value = { exists: true, alive: false }
					} else if (event.type === "block_event" && event.payload.name === "process_changed") {
						// Foreground can be null while the terminal's program is still alive.
						observation.value = undefined
					} else {
						return
					}

					observation.version++
					observation.checkedAt = Date.now()
					this.onChange()
				},
				disconnected,
			)
		} catch {
			disconnected()
		}
	}

	readonly read = async (blockId: string, signal?: AbortSignal): Promise<ProcessStatus> => {
		signal?.throwIfAborted()
		const observation = this.observations.get(blockId) ?? { version: 0 }
		this.observations.set(blockId, observation)

		// Reconcile even on a healthy stream: CLI startup has no subscription-ready marker,
		// and a disconnect can race a snapshot. No stale observation lives indefinitely.
		if (this.healthy && observation.value && Date.now() - observation.checkedAt! < 30_000) {
			return observation.value
		}

		const generation = this.generation
		const version = observation.version
		const value = await readProcess(this.exec, blockId, signal)

		if (this.observations.get(blockId) === observation && generation === this.generation) {
			// An exit/close received during the query wins over its older snapshot.
			if (version !== observation.version) return this.read(blockId, signal)

			if (this.healthy) {
				observation.value = value
				observation.checkedAt = Date.now()
			}
		}

		return value
	}

	stop(): void {
		this.active = false
		this.healthy = false
		this.generation++
		this.disconnect?.()
		this.disconnect = undefined

		if (this.retry) clearTimeout(this.retry)
		this.retry = undefined
		this.retryDelay = 1000
		this.observations.clear()
		this.onChange = () => {}
	}
}

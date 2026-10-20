import type { ParentContext } from "./contracts"
import type { RunState } from "./rex"
import type { RunMetadata } from "./runs"

export interface RunStatus {
	run: Pick<RunMetadata, "handle" | "name" | "createdAt" | "outcome">
	state: RunState
}

interface ReporterOptions {
	write?: (data: string) => void
	isTTY?: boolean
	env?: NodeJS.ProcessEnv
}

// Leave room for Pi's root record on terminals supporting only the minimum 64.
const MAX_RECORDS = 63

function encodeText(text: string, maxBytes: number): string {
	// OSC text must be single-line, without C0/C1 controls. Also disarm bidi overrides.
	// oxlint-disable-next-line no-control-regex -- Sanitize untrusted terminal labels.
	const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").trim()
	const bytes = Buffer.from(clean, "utf8")
	let end = Math.min(bytes.length, maxBytes)

	while (end < bytes.length && end > 0 && (bytes[end]! & 0xc0) === 0x80) end--

	return bytes.subarray(0, end).toString("base64")
}

function activity(status: RunStatus) {
	switch (status.state) {
		case "starting":
			return { state: "working", message: "Starting" }
		case "busy":
			return { state: "working", message: "Running" }
		case "idle":
			switch (status.run.outcome) {
				case "success":
					return { state: "done", message: "Finished" }
				case "error":
					return { state: "error", message: "Failed" }
				case "aborted":
					return { state: "idle", message: "Cancelled" }
				default:
					return { state: "idle", message: "Idle" }
			}

		case "error":
			return { state: "error", message: "Failed" }
		case "exited":
			return { state: "error", message: "Exited" }
		case "suspended":
			return { state: "idle", message: "Suspended" }
		case "stopped":
			return { state: "idle", message: "Stopped" }
		case "unknown":
			return { state: "idle", message: "Status unavailable" }
	}
}

function clear(id: string): string {
	return `\x1b]7501;state=clear:id=${id}\x1b\\`
}

/** Parent-terminal records only; each Rex child's own Pi owns its terminal's root. */
export class ProgramStatusReporter {
	private readonly write: (data: string) => void
	private readonly isTTY: boolean
	private readonly env: NodeJS.ProcessEnv
	private readonly sent = new Map<string, string>()
	private active = false
	private listening = false

	constructor(options: ReporterOptions = {}) {
		this.write =
			options.write ??
			((data) => {
				process.stdout.write(data)
			})
		this.isTTY = options.isTTY ?? process.stdout.isTTY === true
		this.env = options.env ?? process.env
	}

	start(ctx: Pick<ParentContext, "hasUI" | "mode">): void {
		this.dispose()
		this.active =
			ctx.hasUI && ctx.mode === "tui" && this.isTTY && this.env.TERM !== "dumb" && this.env.PI_PROGRAM_STATUS !== "0"

		if (this.active && process.platform !== "win32") {
			process.on("SIGCONT", this.resend)
			this.listening = true
		}
	}

	// Pi clears all records on suspend; unchanged children must be restored too.
	private readonly resend = (): void => {
		if (!this.active) return

		for (const report of this.sent.values()) this.write(report)
	}

	sync(statuses: RunStatus[]): void {
		if (!this.active) return
		const candidates = []

		for (const status of statuses) {
			if (status.state === "stopped") continue

			// Handles are generated hex strings. Never let malformed metadata address the root.
			if (!/^[a-z0-9]{1,32}$/.test(status.run.handle)) continue
			const id = `subagents/${status.run.handle}`
			const { state, message } = activity(status)
			const title = encodeText(status.run.name ?? status.run.handle, 192)
			const msg = encodeText(message, 2048)
			const report = `\x1b]7501;state=${state}:id=${id}:app=pi-subagents:title=${title}:msg=${msg}\x1b\\`
			candidates.push({ id, report, working: state === "working", createdAt: status.run.createdAt })
		}

		candidates.sort(
			(a, b) =>
				Number(b.working) - Number(a.working) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
		)
		const desired = new Map(candidates.slice(0, MAX_RECORDS).map(({ id, report }) => [id, report]))

		// Clear before adding, avoiding eviction of Pi's root at the terminal's record cap.
		for (const id of this.sent.keys()) {
			if (desired.has(id)) continue
			this.write(clear(id))
			this.sent.delete(id)
		}

		for (const [id, report] of desired) {
			if (this.sent.get(id) === report) continue
			this.write(report)
			this.sent.set(id, report)
		}
	}

	dispose(): void {
		this.active = false

		if (this.listening) process.off("SIGCONT", this.resend)
		this.listening = false

		for (const id of this.sent.keys()) this.write(clear(id))
		this.sent.clear()
	}
}

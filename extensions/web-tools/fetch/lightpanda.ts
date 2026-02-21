import { spawn } from "node:child_process"

const LIGHTPANDA_COMMAND = process.env.LIGHTPANDA_PATH || "lightpanda"

export type LightpandaResult = {
	content: string | null
	error: string | null
}

export async function runLightpandaFetch(
	url: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<LightpandaResult> {
	return await new Promise<LightpandaResult>((resolve) => {
		const child = spawn(LIGHTPANDA_COMMAND, ["fetch", "--dump", url], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
		})

		const chunks: Buffer[] = []
		const stderrChunks: Buffer[] = []
		let settled = false

		const finish = (result: LightpandaResult) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal?.removeEventListener("abort", onAbort)
			resolve(result)
		}

		const onAbort = () => {
			child.kill("SIGKILL")
			finish({ content: null, error: "aborted" })
		}

		const timer = setTimeout(() => {
			child.kill("SIGKILL")
			finish({ content: null, error: `timed out after ${timeoutMs}ms` })
		}, timeoutMs)

		if (signal?.aborted) {
			onAbort()
			return
		}

		signal?.addEventListener("abort", onAbort, { once: true })

		child.stdout.on("data", (chunk: Buffer | string) => {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
		})

		child.stderr.on("data", (chunk: Buffer | string) => {
			stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
		})

		child.on("error", (err: NodeJS.ErrnoException) => {
			const msg = err.code === "ENOENT" ? `not found (${LIGHTPANDA_COMMAND})` : `spawn error: ${err.message}`
			finish({ content: null, error: msg })
		})

		child.on("close", (code) => {
			if (code !== 0) {
				const stderr = Buffer.concat(stderrChunks)
					.toString("utf8")
					.split("\n")
					.filter((l) => !l.startsWith("info(telemetry)"))
					.join("\n")
					.trim()
				const detail = stderr || `exit code ${code}`
				finish({ content: null, error: detail })
				return
			}
			const out = Buffer.concat(chunks).toString("utf8")
			finish({ content: out.trim() ? out : null, error: null })
		})
	})
}

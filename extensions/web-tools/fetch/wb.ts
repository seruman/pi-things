import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const WB_COMMAND = process.env.WB_PATH || "wb"
const WB_FETCH_DIR_FROM_ENV = process.env.WB_FETCH_WB_DIR
const WB_FETCH_DIR =
	WB_FETCH_DIR_FROM_ENV || join(tmpdir(), `pi-web-fetch-wb-${process.pid}-${randomBytes(4).toString("hex")}`)
const DEFAULT_RESOURCE_TIMEOUT_SECONDS = 3
const OUTER_HTML_SCRIPT = "return document.documentElement ? document.documentElement.outerHTML : ''"

if (!WB_FETCH_DIR_FROM_ENV) {
	process.once("exit", () => rmSync(WB_FETCH_DIR, { recursive: true, force: true }))
}

export type WbResult = {
	content: string | null
	error: string | null
}

function wbEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		WB_DIR: WB_FETCH_DIR,
		WB_SKILL_AUTO_UPDATE: "off",
	}
}

function remainingMs(deadline: number): number {
	return Math.max(0, deadline - Date.now())
}

function browserIdFromOutput(output: string): string {
	const parsed = JSON.parse(output) as { browser?: unknown }
	if (typeof parsed.browser !== "string" || !parsed.browser) throw new Error("wb did not return a browser id")
	return parsed.browser
}

async function runWb(args: string[], timeoutMs: number, signal: AbortSignal | undefined): Promise<string> {
	if (timeoutMs <= 0) throw new Error("timed out")

	return await new Promise<string>((resolve, reject) => {
		const child = spawn(WB_COMMAND, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: wbEnv(),
		})

		const stdoutChunks: Buffer[] = []
		const stderrChunks: Buffer[] = []
		let settled = false

		const cleanup = () => {
			clearTimeout(timer)
			signal?.removeEventListener("abort", abort)
		}

		const settle = (fn: () => void) => {
			if (settled) return
			settled = true
			cleanup()
			fn()
		}

		const abort = () => {
			child.kill("SIGKILL")
			settle(() => reject(new Error("aborted")))
		}

		const timer = setTimeout(() => {
			child.kill("SIGKILL")
			settle(() => reject(new Error(`timed out after ${timeoutMs}ms`)))
		}, timeoutMs)

		if (signal?.aborted) {
			abort()
			return
		}
		signal?.addEventListener("abort", abort, { once: true })

		child.stdout.on("data", (chunk: Buffer | string) => {
			stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
		})

		child.stderr.on("data", (chunk: Buffer | string) => {
			stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
		})

		child.on("error", (error: NodeJS.ErrnoException) => {
			const message = error.code === "ENOENT" ? `not found (${WB_COMMAND})` : `spawn error: ${error.message}`
			settle(() => reject(new Error(message)))
		})

		child.on("close", (code) => {
			const stdout = Buffer.concat(stdoutChunks).toString("utf8")
			const stderr = Buffer.concat(stderrChunks).toString("utf8").trim()
			if (code !== 0) {
				settle(() => reject(new Error(stderr || stdout.trim() || `exit code ${code}`)))
				return
			}
			settle(() => resolve(stdout))
		})
	})
}

async function removeBrowser(browserId: string): Promise<void> {
	try {
		await runWb(["remove", browserId], 2_000, undefined)
	} catch {}
}

export async function runWbFetch(url: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<WbResult> {
	const deadline = Date.now() + timeoutMs
	let browserId: string | null = null

	try {
		browserId = browserIdFromOutput(await runWb([url], remainingMs(deadline), signal))

		const waitBudgetMs = remainingMs(deadline)
		if (waitBudgetMs >= 1_000) {
			const resourceTimeoutSeconds = Math.max(
				1,
				Math.min(DEFAULT_RESOURCE_TIMEOUT_SECONDS, Math.floor(waitBudgetMs / 1000)),
			)
			await runWb(
				["wait-resources", browserId, "--resource-timeout", String(resourceTimeoutSeconds)],
				remainingMs(deadline),
				signal,
			)
		}

		const html = await runWb(["eval", "--body", browserId, OUTER_HTML_SCRIPT], remainingMs(deadline), signal)
		return { content: html.trim() ? html : null, error: null }
	} catch (error) {
		return { content: null, error: error instanceof Error ? error.message : String(error) }
	} finally {
		if (browserId) await removeBrowser(browserId)
	}
}

import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { RouterConfig } from "./config"

interface Clock {
	now(): number
	every(callback: () => void, ms: number): () => void
	after(callback: () => void, ms: number): () => void
}

const clock: Clock = {
	now: () => performance.now(),
	every(callback, ms) {
		const timer = setInterval(callback, ms)
		timer.unref()
		return () => clearInterval(timer)
	},
	after(callback, ms) {
		const timer = setTimeout(callback, ms)
		timer.unref()
		return () => clearTimeout(timer)
	},
}

export function seconds(ms: number) {
	return `${(ms / 1000).toFixed(1)}s`
}

/** One temporary widget per router; stale completions cannot erase a newer request. */
export function createRoutingProgress(key = "model-router.routing", time: Clock = clock) {
	let clearCurrent: (() => void) | undefined
	return {
		clear() {
			clearCurrent?.()
		},
		start(ctx: ExtensionContext, config: RouterConfig["classifier"], signal: AbortSignal) {
			clearCurrent?.()
			if (!ctx.hasUI || ctx.mode !== "tui" || signal.aborted) return { finish(_text: string) {}, stop() {} }
			const start = time.now()
			let finished = false
			let cancelTimer: (() => void) | undefined
			const clear = () => {
				cancelTimer?.()
				signal.removeEventListener("abort", clear)
				if (clearCurrent !== clear) return
				clearCurrent = undefined
				ctx.ui.setWidget(key, undefined)
			}
			clearCurrent = clear
			const render = () => {
				if (clearCurrent !== clear) return
				const elapsed = Math.max(0, time.now() - start)
				const model = config.model.replace(/\p{Cc}/gu, "")
				ctx.ui.setWidget(key, [
					`Routing · ${elapsed >= 2000 ? "waiting for local" : "local"} ${model} · ${seconds(elapsed)} / ${seconds(config.timeoutMs)}`,
					...(elapsed >= 2000 ? ["Model may be loading after idle."] : []),
				])
			}
			signal.addEventListener("abort", clear, { once: true })
			render()
			cancelTimer = time.every(render, 250)
			return {
				finish(text: string) {
					if (clearCurrent !== clear || signal.aborted) return
					finished = true
					cancelTimer?.()
					ctx.ui.setWidget(key, [text.replace(/\p{Cc}/gu, "")])
					cancelTimer = time.after(clear, 2500)
				},
				stop() {
					// Called in finally: remove pending UI on failure, preserve a brief completed result.
					if (!finished) clear()
				},
			}
		},
	}
}

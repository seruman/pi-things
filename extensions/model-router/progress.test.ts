import { describe, expect, test } from "bun:test"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { createRoutingProgress } from "./progress"

function harness(mode: ExtensionContext["mode"] = "tui", hasUI = true) {
	let now = 0
	const timers = new Map<() => void, { at: number; interval?: number }>()
	const widgets: (string[] | undefined)[] = []
	const ctx = {
		mode,
		hasUI,
		ui: {
			setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
		},
	} as unknown as ExtensionContext
	const progress = createRoutingProgress("test", {
		now: () => now,
		every(callback, ms) {
			timers.set(callback, { at: now + ms, interval: ms })
			return () => timers.delete(callback)
		},
		after(callback, ms) {
			timers.set(callback, { at: now + ms })
			return () => timers.delete(callback)
		},
	})
	const controller = new AbortController()
	const config = { baseUrl: "http://localhost:11434/v1", model: "clef-flash:9b-mxfp8", timeoutMs: 10_000 }
	function advance(ms: number) {
		now += ms
		for (const [callback, timer] of [...timers]) {
			if (timer.at > now) continue
			if (timer.interval) timer.at = now + timer.interval
			else timers.delete(callback)
			callback()
		}
	}
	return { progress, ctx, controller, config, widgets, timers, advance }
}

describe("routing progress widget", () => {
	test("appears immediately, updates elapsed/deadline, and qualifies the cold-load hint", () => {
		const h = harness()
		const view = h.progress.start(h.ctx, h.config, h.controller.signal)
		expect(h.widgets.at(-1)).toEqual(["Routing · local clef-flash:9b-mxfp8 · 0.0s / 10.0s"])
		h.advance(750)
		expect(h.widgets.at(-1)?.[0]).toContain("0.8s / 10.0s")
		h.advance(1250)
		expect(h.widgets.at(-1)).toEqual([
			"Routing · waiting for local clef-flash:9b-mxfp8 · 2.0s / 10.0s",
			"Model may be loading after idle.",
		])
		view.stop()
		expect(h.widgets.at(-1)).toBeUndefined()
		expect(h.timers.size).toBe(0)
	})

	test("shows a completed result briefly, then removes it without pending updates", () => {
		const h = harness()
		const view = h.progress.start(h.ctx, h.config, h.controller.signal)
		view.finish("Routing complete · physical/small · 0.3s")
		view.stop()
		expect(h.widgets.at(-1)).toEqual(["Routing complete · physical/small · 0.3s"])
		h.advance(2499)
		expect(h.widgets.at(-1)).toEqual(["Routing complete · physical/small · 0.3s"])
		h.advance(1)
		expect(h.widgets.at(-1)).toBeUndefined()
		expect(h.timers.size).toBe(0)
	})

	test.each(["abort", "clear", "stop"] as const)("%s removes pending UI and rejects late completion", (action) => {
		const h = harness()
		const view = h.progress.start(h.ctx, h.config, h.controller.signal)
		if (action === "abort") h.controller.abort()
		else if (action === "clear") h.progress.clear()
		else view.stop()
		view.finish("stale result")
		h.advance(10000)
		expect(h.widgets.at(-1)).toBeUndefined()
		expect(h.timers.size).toBe(0)
	})

	test("a previous request cannot clear or overwrite a newer widget", () => {
		const h = harness()
		const first = h.progress.start(h.ctx, h.config, h.controller.signal)
		const next = h.progress.start(h.ctx, { ...h.config, timeoutMs: 5000 }, new AbortController().signal)
		h.controller.abort()
		first.stop()
		first.finish("stale")
		expect(h.widgets.at(-1)?.[0]).toContain("0.0s / 5.0s")
		expect(h.timers.size).toBe(1)
		next.stop()
	})

	test.each(["json", "print", "rpc"] as const)("does not create terminal UI or timers in %s mode", (mode) => {
		const h = harness(mode)
		const view = h.progress.start(h.ctx, h.config, h.controller.signal)
		view.finish("done")
		view.stop()
		expect(h.widgets).toEqual([])
		expect(h.timers.size).toBe(0)
	})

	test("does not create UI when absent or already cancelled", () => {
		for (const hasUI of [true, false]) {
			const h = harness("tui", hasUI)
			if (hasUI) h.controller.abort()
			h.progress.start(h.ctx, h.config, h.controller.signal)
			expect(h.widgets).toEqual([])
			expect(h.timers.size).toBe(0)
		}
	})
})

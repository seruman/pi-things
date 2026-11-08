import type { Theme } from "@earendil-works/pi-coding-agent"
import {
	type Component,
	MouseRegion,
	ScrollView,
	type TuiMouseEvent,
	type TuiMode,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui"
import { pendingText, safeLabel, safeText } from "./ui"
import type { Message } from "./mailbox"

export const PENDING_WIDGET = "session-messages"

export const PENDING_PREVIEWS = 3

export const PENDING_WIDTH = 80

export interface PendingMessage {
	key: string
	pool: Extract<Message["route"], { kind: "pool" }>["pool"] | undefined
	sender: string
	text: string
	delivery: Message["delivery"]
}

type Action = string | undefined

/** UI-only, no focus or delivery effects. Mouse routing belongs to Pi fullscreen.
 * Regular-mode hosts can use the public controls without taking editor focus.
 */
export class PendingWidget implements Component {
	private messages: PendingMessage[] = []
	private disposed = false
	private expanded = new Set<string>()
	private showAll = false
	private toolsExpanded: boolean
	private actions: Action[] = []
	private pressed: Action
	private contentActions: Action[] = []
	private headingRows = new Map<string, number>()
	private revealKey: string | undefined
	private cached: { width: number; lines: string[] } | undefined
	private scroll: ScrollView
	private region: MouseRegion

	constructor(
		private theme: () => Theme,
		private requestRender: () => void,
		private terminalRows: () => number,
		private getToolsExpanded: () => boolean = () => false,
		private getMode: () => TuiMode = () => "fullscreen",
	) {
		this.toolsExpanded = this.getToolsExpanded()
		this.showAll = this.toolsExpanded
		this.scroll = new ScrollView({ render: (width) => this.renderContent(width), invalidate() {} })
		this.region = new MouseRegion({ render: (width) => this.renderFrame(width), invalidate() {} }, (event) => {
			if (event.type === "wheel") {
				this.pressed = undefined
				this.scroll.scrollBy(event.wheelDelta ?? 0)

				return { handled: true, render: true }
			}

			if (event.button !== "left" || event.shift || event.alt || event.ctrl || event.type === "drag") {
				this.pressed = undefined

				return undefined
			}

			const action = event.x >= 2 && event.x < 4 ? this.actions[event.y] : undefined

			if (event.type === "press") {
				this.pressed = action

				return action ? { handled: true, render: false } : undefined
			}

			if (event.type !== "click") return undefined
			const pressed = this.pressed
			this.pressed = undefined

			if (!action || action !== pressed) return undefined

			if (action === "list") this.setShowAll(!this.showAll)
			else if (action === "top") this.scrollToStart()
			else this.toggleMessage(action.slice("message:".length))

			return { handled: true, render: true }
		})
	}

	setMessages(messages: PendingMessage[]): void {
		if (this.disposed) return

		if (
			messages.length === this.messages.length &&
			messages.every((message, index) => {
				const previous = this.messages[index]!

				return (
					message.key === previous.key &&
					message.pool === previous.pool &&
					message.sender === previous.sender &&
					message.delivery === previous.delivery &&
					message.text === previous.text
				)
			})
		) {
			return
		}

		if (this.toolsExpanded) {
			const previousKeys = new Set(this.messages.map((message) => message.key))

			for (const message of messages) {
				if (!previousKeys.has(message.key)) this.expanded.add(message.key)
			}
		}

		this.messages = messages.map((message) => ({ ...message }))
		const keys = new Set(messages.map((message) => message.key))

		for (const key of this.expanded) {
			if (!keys.has(key)) this.expanded.delete(key)
		}

		if (messages.length === 0) {
			this.revealKey = undefined
			this.showAll = this.toolsExpanded
			this.scroll.scrollToStart()
		}

		this.changed()
	}

	toggleMessage(key: string): void {
		if (this.disposed || !this.messages.some((message) => message.key === key)) return

		if (this.expanded.has(key)) this.expanded.delete(key)
		else this.expanded.add(key)
		this.changed()
	}

	revealMessage(number: number): boolean {
		const message = this.messages[number - 1]

		if (this.disposed || !Number.isSafeInteger(number) || !message) return false

		this.showAll = true
		this.toggleMessage(message.key)
		this.revealKey = message.key

		return true
	}

	scrollPage(direction: "up" | "down"): void {
		this.scrollBy(Math.max(1, this.scroll.viewportHeight) * (direction === "up" ? -1 : 1))
	}

	setShowAll(showAll: boolean): void {
		if (this.disposed) return
		this.showAll = showAll
		this.revealKey = undefined
		this.scroll.scrollToStart()
		this.changed()
	}

	scrollBy(lines: number): void {
		if (!this.disposed) this.scroll.scrollBy(lines)
	}

	scrollToStart(): void {
		this.revealKey = undefined

		if (!this.disposed) this.scroll.scrollToStart()
	}

	dispose(): void {
		this.disposed = true
		this.messages = []
		this.expanded.clear()
		this.actions = []
		this.pressed = undefined
		this.contentActions = []
		this.headingRows.clear()
		this.revealKey = undefined
		this.cached = undefined
		this.scroll.updateLayout(0, 0, () => {})
	}

	invalidate(): void {
		this.cached = undefined
	}

	private changed(): void {
		this.invalidate()
		this.actions = []
		this.pressed = undefined
		this.requestRender()
	}

	handleMouse(event: TuiMouseEvent) {
		if (this.disposed || event.x < 0 || event.x >= event.width || event.y < 0 || event.y >= event.height) {
			return undefined
		}

		return this.region.handleMouse(event)
	}

	render(width: number): string[] {
		if (this.disposed) return []
		const toolsExpanded = this.getToolsExpanded()

		// Pi's native global toggle already requests a render. Observe it here,
		// before cached content, without taking over shortcuts or editor focus.
		if (toolsExpanded !== this.toolsExpanded) {
			this.toolsExpanded = toolsExpanded
			this.showAll = toolsExpanded
			this.expanded = new Set(toolsExpanded ? this.messages.map((message) => message.key) : [])
			this.pressed = undefined
			this.revealKey = undefined
			this.scroll.scrollToStart()
			this.invalidate()
		}

		return this.region.render(Math.min(width, PENDING_WIDTH))
	}

	private renderContent(width: number): string[] {
		if (this.cached?.width === width) return this.cached.lines
		const theme = this.theme()
		const lines: string[] = []
		this.contentActions = []
		this.headingRows.clear()

		for (const [index, message] of (this.showAll
			? this.messages
			: this.messages.slice(0, PENDING_PREVIEWS)
		).entries()) {
			const inner = Math.max(1, width - 4)
			const body = wrapTextWithAnsi(safeText(message.text), inner)

			const label =
				(message.pool === undefined ? "" : theme.fg("dim", `[${safeLabel(message.pool)}] `)) +
				pendingText(theme, "accent", safeLabel(message.sender)) +
				theme.fg("dim", ` · ${message.delivery} · #${index + 1}`)

			const expandable = body.length > 1

			const expanded = expandable && this.expanded.has(message.key)
			const marker = expandable ? (expanded ? "▾ " : "▸ ") : "  "
			this.headingRows.set(message.key, lines.length)
			lines.push(truncateToWidth(pendingText(theme, "warning", `│ ${marker}`) + label, width))
			this.contentActions.push(expandable ? `message:${message.key}` : undefined)

			const preview = expandable
				? truncateToWidth(body[0]!, Math.max(0, inner - 1), "").trimEnd() + "…"
				: (body[0] ?? "")

			for (const line of expanded ? body : [preview]) {
				lines.push(pendingText(theme, "warning", "│   ") + theme.fg("dim", line))
				this.contentActions.push(undefined)
			}
		}

		this.cached = { width, lines }

		return lines
	}

	private renderFrame(width: number): string[] {
		this.actions = []

		if (this.disposed || width <= 0 || this.messages.length === 0) return []
		const budget = Math.max(1, Math.min(12, Math.floor(this.terminalRows() / 3)))
		const hasListControl = this.messages.length > PENDING_PREVIEWS && budget >= 2
		const headerHeight = budget >= 3 ? 1 : 0
		// Widgets are opaque leaves in the editor Container, not layout roots.
		// ScrollView.render is unbounded: host its public viewport/clamp state here.
		const content = this.scroll.render(width)

		// Regular mode has no mouse routing: global expansion must expose the
		// whole body/list to terminal scrollback, not strand it in a wheel viewport.
		const bodyHeight =
			this.toolsExpanded && this.getMode() === "regular"
				? content.length
				: budget - headerHeight - (hasListControl ? 1 : 0)

		this.scroll.updateLayout(content.length, bodyHeight, this.requestRender)

		if (this.revealKey !== undefined) {
			const row = this.headingRows.get(this.revealKey)

			if (row !== undefined) this.scroll.scrollTo(row)
			this.revealKey = undefined
		}

		const top = this.scroll.scrollTop
		const bottom = Math.min(content.length, top + bodyHeight)
		const lines: string[] = []

		if (headerHeight) {
			const position = content.length > bodyHeight ? ` · ${top + 1}–${bottom}/${content.length} · scroll` : ""
			lines.push(
				pendingText(
					this.theme(),
					"warning",
					`  ${top > 0 ? "↑" : " "} Messages · ${this.messages.length} pending · /session-messages pending${position}`,
				),
			)
			this.actions.push(top > 0 ? "top" : undefined)
		}

		lines.push(...content.slice(top, bottom))
		this.actions.push(...this.contentActions.slice(top, bottom))

		if (hasListControl) {
			lines.push(
				pendingText(
					this.theme(),
					"accent",
					this.showAll ? "  ▾ Show fewer" : `  ▸ +${this.messages.length - PENDING_PREVIEWS} more`,
				),
			)
			this.actions.push("list")
		}

		return lines.map((line) => truncateToWidth(line, width, "", true))
	}
}

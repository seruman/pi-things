import { join } from "node:path"
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent"
import type { ClassifyTier } from "./classifier"
import { loadConfig } from "./config"
import { DECISION_ENTRY, ROUTER_PROVIDER, type RouterState, createRouter } from "./router"

export function createModelRouterExtension(options: { configPath?: string; classify?: ClassifyTier } = {}) {
	return (pi: ExtensionAPI) => {
		const { routers, ...settings } = loadConfig(options.configPath ?? join(getAgentDir(), "model-router.json"))
		for (const [name, definition] of Object.entries(routers)) {
			const id = `auto-${name}`
			const router = createRouter(
				{ ...settings, ...definition },
				(data) => pi.appendEntry(DECISION_ENTRY, { ...data, router: id }),
				options.classify,
			)
			pi.on("before_agent_start", (event, ctx) => {
				if (ctx.model?.provider === ROUTER_PROVIDER && ctx.model.id === id) {
					router.beginRun(event.prompt, !!event.images?.length)
				}
			})
			// agent_end can precede retries/recovery; only the settled event closes the routing boundary.
			pi.on("agent_settled", () => router.resetRun())
			pi.on("session_start", () => router.resetRun())
			pi.on("session_tree", () => router.resetRun())
			pi.on("session_shutdown", () => router.resetRun())

			pi.registerVirtualModel<RouterState>({
				provider: ROUTER_PROVIDER,
				id,
				name: `Auto: ${name}`,
				// Thinking comes from each configured tier, not a separate virtual-level override.
				thinkingLevels: ["off"],
				route: (request, ctx) => router.route(request, ctx),
			})
		}
	}
}

export default createModelRouterExtension()

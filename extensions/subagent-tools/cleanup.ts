import type { SubagentRegistry } from "./registry"
import { killGracefully } from "./spawn"

let cleanupRegistered = false
let registryRef: SubagentRegistry | null = null

function cleanupAll(): void {
	if (!registryRef) return
	for (const entry of registryRef.running()) {
		killGracefully(entry)
		registryRef.updateStatus(entry.agentId, "stopped", 1)
	}
}

export function registerCleanup(registry: SubagentRegistry): void {
	if (cleanupRegistered) return
	registryRef = registry
	cleanupRegistered = true

	process.on("exit", cleanupAll)

	process.on("SIGINT", () => {
		cleanupAll()
	})

	process.on("SIGTERM", () => {
		cleanupAll()
	})
}

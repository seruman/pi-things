import assert from "node:assert/strict"
import { appendFileSync } from "node:fs"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { listEndpoints } from "../../lib/session-delivery/mailbox"
import { acquireDelivery } from "../../lib/session-delivery/runtime"
import sessionMessages from "../index"
import { controlledProvider } from "./provider"

export default function (pi: ExtensionAPI) {
	sessionMessages(pi)
	const delivery = acquireDelivery(pi)
	controlledProvider(pi, [], [])

	const record = (reason: string) => {
		const path = process.env.SESSION_MESSAGES_TEST_REPORT
		assert(path)
		const endpoints = listEndpoints()
		assert.equal(endpoints.length, 1)
		const endpoint = endpoints[0]
		assert(endpoint)
		appendFileSync(
			path,
			JSON.stringify({
				reason,
				pool: endpoint.membership?.pool ?? null,
				generation: endpoint.membership?.generation ?? null,
				instance: endpoint.instanceId,
				flag: pi.getFlag("session-pool") ?? null,
			}) + "\n",
			{ mode: 0o600 },
		)
	}

	pi.on("session_start", (event) => record(event.reason))
	pi.registerCommand("sm-pool-report", { handler: async () => {} })
	pi.registerCommand("sm-pool-reload", {
		async handler(_args, ctx) {
			delivery.leave()
			await new Promise((resolve) => setTimeout(resolve, 250))
			record("leave")
			await ctx.reload()
		},
	})
}

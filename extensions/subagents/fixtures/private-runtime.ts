import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import subagents from "../index"
import { getRun } from "../runs"
import { familyPolicy } from "../family"
import { readCompletion } from "../completion"
import { SessionMailbox, listEndpoints } from "../../lib/session-delivery/mailbox"
import { acquireDelivery } from "../../lib/session-delivery/runtime"
import { runHandleSchema } from "../../lib/session-delivery/identity"
import { controlledProvider } from "../../session-messages/fixtures/provider"

export default function (pi: ExtensionAPI) {
	subagents(pi)
	controlledProvider(pi, [{}], [])
	pi.registerCommand("private-proof", {
		description: "Verify private-only managed installation without network calls",
		async handler(_args, ctx) {
			const report = process.env.PRIVATE_RUNTIME_REPORT
			const rawHandle = process.env.PRIVATE_RUNTIME_HANDLE
			assert(report && rawHandle)
			const handle = runHandleSchema.parse(rawHandle)
			const run = getRun(handle)
			assert(run.relation && run.childSessionId)
			const delivery = acquireDelivery(pi)
			const parent = new SessionMailbox({ sessionId: run.parentSessionId, cwd: ctx.cwd }, undefined, familyPolicy)

			try {
				parent.join("parent-only")
				assert.equal(delivery.status(), undefined)
				assert.equal(
					pi.getAllTools().some((t) => t.name === "session_send"),
					false,
				)
				parent.send(run.childSessionId, "private delegated task", "steer", {
					kind: "family",
					relation: run.relation,
					handle,
					direction: "delegate",
				})
				const deadline = Date.now() + 5000

				while (!readCompletion(getRun(handle))) {
					assert(Date.now() < deadline, "Private task did not complete")
					await new Promise((resolve) => setTimeout(resolve, 5))
				}

				await ctx.waitForIdle()
				delivery.send(run.parentSessionId, "private reply", "steer", {
					kind: "family",
					relation: run.relation,
					handle,
					direction: "reply",
				})
				assert.equal(parent.receive(() => {}).length, 1)
				assert.equal(
					ctx.sessionManager.getBranch().filter((e) => e.type === "message" && e.message.role === "user").length,
					0,
				)
				assert.equal(ctx.sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.display).length, 1)
				writeFileSync(
					report,
					JSON.stringify({
						reply: pi.getActiveTools().includes("agent_reply"),
						public: pi.getAllTools().some((t) => t.name === "session_send"),
						private: listEndpoints().find((e) => e.sessionId === run.childSessionId)?.membership === undefined,
						completion: readCompletion(getRun(handle))?.sequence,
					}),
					{ mode: 0o600 },
				)
			} finally {
				parent.dispose()
			}
		},
	})
}

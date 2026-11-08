import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import type { TranscriptContext } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { controlledProvider, gate, type Step } from "./provider"
import sessionMessages from "../index"

export default function (pi: ExtensionAPI) {
	sessionMessages(pi)
	pi.registerCommand("sm-tool-proof", {
		description: "Report the runtime tool restrictions",
		async handler() {
			const path = process.env.SESSION_MESSAGES_TEST_REPORT
			assert(path)
			writeFileSync(path, JSON.stringify(pi.getActiveTools().filter((name) => name.startsWith("session_"))), {
				mode: 0o600,
			})
		},
	})
	const steps: Step[] = []
	const requests: TranscriptContext[] = []
	controlledProvider(pi, steps, requests)
	pi.registerCommand("sm-delivery-proof", {
		description: "Deterministic delivery proof, no network calls",
		async handler(_args, ctx) {
			const until = async (check: () => boolean) => {
				const deadline = Date.now() + 5000

				while (!check()) {
					assert(Date.now() < deadline, "Timed out waiting for provider gate")
					await new Promise((resolve) => setTimeout(resolve, 5))
				}
			}

			const results: string[] = []

			for (const delivery of ["steer", "followUp", "passive"] as const) {
				const hold = gate()
				const start = requests.length
				steps.push({ wait: hold.promise, tool: true }, {}, ...(delivery === "followUp" ? [{}] : []))
				pi.sendMessage(
					{ customType: "fixture-start", content: `start-${delivery}`, display: true },
					{ triggerTurn: true },
				)
				await until(() => requests.length === start + 1)
				const text = `peer-${delivery}`
				pi.sendMessage(
					{ customType: "fixture-peer", content: text, display: true },
					{ triggerTurn: delivery !== "passive", deliverAs: delivery === "followUp" ? "followUp" : "steer" },
				)
				hold.open()
				await ctx.waitForIdle()
				assert.equal(requests.length - start, delivery === "followUp" ? 3 : 2)
				assert.equal(JSON.stringify(requests[start + 1]).includes(text), delivery !== "followUp")
				assert.equal(
					ctx.sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.content === text && e.display)
						.length,
					1,
				)
				results.push(delivery)
			}

			const count = requests.length
			pi.sendMessage({ customType: "fixture-peer", content: "idle-passive", display: true }, { triggerTurn: false })
			await new Promise((resolve) => setTimeout(resolve, 20))
			assert.equal(requests.length, count)
			steps.push({})
			pi.sendMessage({ customType: "fixture-peer", content: "idle-wake", display: true }, { triggerTurn: true })
			await until(() => requests.length === count + 1)
			await ctx.waitForIdle()
			assert.equal(
				ctx.sessionManager.getBranch().filter((e) => e.type === "message" && e.message.role === "user").length,
				0,
			)
			const path = process.env.SESSION_MESSAGES_TEST_REPORT
			assert(path, "SESSION_MESSAGES_TEST_REPORT is required")
			writeFileSync(
				path,
				JSON.stringify({ results: [...results, "idle-passive", "idle-wake"], requests: requests.length }),
				{ mode: 0o600 },
			)
		},
	})
}

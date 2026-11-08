import { expect, test } from "bun:test"
import { acquireDelivery } from "../lib/session-delivery/runtime"
import { installPrivateChild } from "../subagents/private-child"
import { installParent } from "../subagents/index"
import { createSessionMessages } from "./index"
import { sdk, testDirectory } from "./fixtures/sdk"

for (const publicPools of [false, true]) {
	test(`command help advertises only installed capabilities: public pools ${publicPools}`, async () => {
		const root = testDirectory()

		const h = await sdk({
			root,
			pool: false,
			extension: async (pi) => {
				acquireDelivery(pi, { root, pollMs: 5 })

				if (publicPools) await createSessionMessages({ root, pollMs: 5 })(pi)
			},
		})

		const commands = h.session.extensionRunner.getRegisteredCommands().filter((c) => c.name === "session-messages")
		expect(commands).toHaveLength(1)
		const description = commands[0]?.description ?? ""
		expect(description).toContain("pending")

		for (const operation of ["join", "leave", "status"]) {
			expect(description.includes(operation)).toBe(publicPools)
		}
	})
}

test("child reply guidance explains idle waking and busy delivery modes", async () => {
	const root = testDirectory()

	const h = await sdk({
		root,
		pool: false,
		extension: (pi) => installPrivateChild(pi, root, acquireDelivery(pi, { root, pollMs: 5 })),
	})

	const tool = h.session.extensionRunner.getToolDefinition("agent_reply")
	const guidance = [tool?.description, ...(tool?.promptGuidelines ?? [])].join(" ")
	expect(guidance).toMatch(/wake.*idle/i)
	expect(guidance).toMatch(/busy.*steer/i)
	expect(guidance).toMatch(/followUp.*after/i)
	expect(guidance).toContain("yield")
})

test("parent spawn guidance explains idle and busy completion delivery", async () => {
	const h = await sdk({ pool: false, extension: (pi) => installParent(pi) })
	const tool = h.session.extensionRunner.getToolDefinition("agent_spawn")
	const guidance = [tool?.description, ...(tool?.promptGuidelines ?? [])].join(" ")
	expect(guidance).toMatch(/wake.*idle/i)
	expect(guidance).toContain("Busy parents receive it at the next steering opportunity.")
})

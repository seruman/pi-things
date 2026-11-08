import { expect, test } from "bun:test"
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai"
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent"
import { createSessionMessages } from "./index"
import { sdk, testDirectory } from "./fixtures/sdk"

test("native codemode and provider loadout follow public membership", async () => {
	const root = testDirectory()

	const h = await sdk({
		root,
		pool: false,
		defaultPrompt: true,
		extension: createSessionMessages({ root }),
		extensions: [createCodemodeExtension({ mode: "on" })],
	})

	h.api.setActiveTools([...h.api.getActiveTools(), "codemode"])
	const code = `text("send present: " + ("session_send" in tools)); try { await tools.session_send({to: "missing", message: "test"}); } catch (e) { text("send error: " + String(e)); } try { text(JSON.stringify(await tools.session_list({}))); } catch (e) { text("unavailable: " + String(e)); }`

	for (const [command, joined] of [
		["", false],
		["join one", true],
		["join two", true],
		["leave", false],
		["join one", true],
	] as const) {
		if (command) await h.session.prompt(`/session-messages ${command}`)
		h.steps.push({ code }, {})
		const start = h.requests.length
		await h.session.prompt("Inspect session tools")
		const request = h.requests[start]

		if (!request) throw new Error("Missing provider request")
		const declarations = getCurrentTools(request.messages)
		const prompt = getCurrentSystemPrompt(request.messages)
		const codemode = declarations.find((tool) => tool.name === "codemode")

		if (!codemode) throw new Error("Missing codemode declaration")
		expect(declarations.some((tool) => tool.name === "session_list")).toBe(joined)
		expect(declarations.some((tool) => tool.name === "session_send")).toBe(joined)
		expect(prompt.includes("Final replies stay in this session")).toBe(joined)

		const results = h.session.sessionManager
			.getBranch()
			.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "codemode",
			)

		const result = results.at(-1)

		if (!result || result.type !== "message" || result.message.role !== "toolResult") {
			throw new Error("Missing codemode result")
		}

		expect(JSON.stringify(result.message.content).includes("unavailable:")).toBe(!joined)
		expect(JSON.stringify(result.message.content)).toContain(`send present: ${joined}`)
		expect(JSON.stringify(result.message.content).includes("tools.session_send does not exist")).toBe(!joined)
		// Codemode workers shut down asynchronously; rapid calls hit its two-worker limit.
		await Bun.sleep(200)
	}

	expect(h.errors).toEqual([])
})

import { expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { z } from "zod"
import { acquireDelivery } from "../lib/session-delivery/runtime"
import { sessionIdSchema } from "../lib/session-delivery/identity"
import { listEndpoints, messageSchema, SessionMailbox, workStatus } from "../lib/session-delivery/mailbox"
import { INCOMING } from "../lib/session-delivery/ui"
import { sdk, testDirectory, until } from "../session-messages/fixtures/sdk"
import { gate, type Step } from "../session-messages/fixtures/provider"
import { installParent } from "./index"
import { installBridge } from "./bridge"
import { familyPolicy } from "./family"
import { getRun, prepareRun, runDirectory, writeMetadata } from "./runs"
import { COMPLETION_MARKER, readCompletion } from "./completion"

async function fixture(
	options: {
		compact?: ReturnType<typeof gate>
		compactStarted?: ReturnType<typeof gate>
		busy?: ReturnType<typeof gate>
		answer?: string
		childWait?: ReturnType<typeof gate>
		childError?: boolean
		pollMs?: number
		parentSteps?: Step[]
	} = {},
) {
	const root = testDirectory()
	const previous = process.env.PI_CODING_AGENT_DIR
	process.env.PI_CODING_AGENT_DIR = root
	let inspect: (() => Promise<void>) | undefined

	const parent = await sdk({
		root,
		pool: false,
		selection: options.parentSteps ? undefined : { noTools: "all" },
		steps: options.parentSteps ?? (options.busy ? [{ wait: options.busy.promise }, {}] : [{}, {}, {}]),
		extension: (pi) => {
			const delivery = acquireDelivery(pi, { root: join(root, "session-messages"), pollMs: options.pollMs ?? 5 })
			delivery.setFamilyPolicy(familyPolicy)
			installParent(
				{
					...pi,
					exec: async (_command, args) => {
						if (args[0] === "block") {
							await inspect?.()

							return { code: 0, stdout: JSON.stringify({ last_exit: null }), stderr: "", killed: false }
						}

						if (args[4] === "block.close") return { code: 0, stdout: "{}", stderr: "", killed: false }
						throw new Error(`Unexpected process operation ${args.join(" ")}`)
					},
				},
				undefined,
				delivery,
			)

			if (options.compact) {
				pi.on("session_before_compact", async (event) => {
					options.compactStarted?.open()
					await options.compact?.promise

					return {
						compaction: {
							summary: "held summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}
				})
			}
		},
	})

	const prepared = prepareRun(sessionIdSchema.parse(parent.session.sessionId))
	writeMetadata({
		version: 1,
		...prepared,
		parentSessionId: sessionIdSchema.parse(parent.session.sessionId),
		blockId: "fake-block",
		cwd: root,
		provider: "session-message-test",
		model: "controlled",
		thinking: "off",
		launchArgs: [],
		createdAt: new Date().toISOString(),
		accountingVersion: 1,
	})

	const child = await sdk({
		root,
		pool: false,
		steps: [{ text: options.answer, wait: options.childWait?.promise, error: options.childError }, {}],
		extension: (pi) => {
			acquireDelivery(pi, { root: join(root, "session-messages"), pollMs: options.pollMs ?? 5 }).setFamilyPolicy(
				familyPolicy,
			)
			installBridge(pi, runDirectory(prepared.handle))
		},
	})

	return {
		parent,
		child,
		prepared,
		setInspection(fn: () => Promise<void>) {
			inspect = fn
		},
		async send() {
			const tool = parent.session.extensionRunner.getToolDefinition("agent_send")

			if (!tool) throw new Error("Missing agent_send")

			return tool.execute(
				"send",
				{ handle: prepared.handle, message: "delegated work" },
				undefined,
				undefined,
				parent.session.extensionRunner.createToolContext("send", undefined),
			)
		},
		async wait(signal?: AbortSignal) {
			const tool = parent.session.extensionRunner.getToolDefinition("agent_wait")

			if (!tool) throw new Error("Missing agent_wait")

			return tool.execute(
				"wait",
				{ handle: prepared.handle },
				signal,
				undefined,
				parent.session.extensionRunner.createToolContext("wait", signal),
			)
		},
		async dispose() {
			inspect = undefined
			await parent.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" })
			await child.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" })

			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
			else process.env.PI_CODING_AGENT_DIR = previous
		},
	}
}

test("actual agent_wait wins against a staged compaction-held completion at the pre-submit gate", async () => {
	const compact = gate(),
		started = gate(),
		inspecting = gate(),
		inspected = gate()

	const f = await fixture({ compact, compactStarted: started })

	try {
		await f.parent.session.prompt("old")
		await f.parent.session.prompt("more")
		const compacting = f.parent.session.compact()
		await started.promise
		await f.child.session.prompt("child task")
		expect(readCompletion(getRun(f.prepared.handle))?.sequence).toBe(1)
		await Bun.sleep(250)
		f.setInspection(async () => {
			inspected.open()
			await inspecting.promise
		})
		const waiting = f.wait()
		await inspected.promise
		compact.open()
		await compacting
		await Bun.sleep(30)
		expect(f.parent.requests).toHaveLength(2)
		inspecting.open()
		expect((await waiting).isError).not.toBe(true)
		await Bun.sleep(250)
		expect(f.parent.requests).toHaveLength(2)
		expect(
			f.parent.session.sessionManager
				.getEntries()
				.filter((e) => e.type === "custom_message" && e.customType === INCOMING),
		).toEqual([])
		expect(
			f.parent.session.sessionManager
				.getEntries()
				.filter((e) => e.type === "custom" && e.customType === COMPLETION_MARKER),
		).toMatchObject([{ data: { kind: "consumed", throughSequence: 1 } }])
		await f.parent.session.reload()
		await f.wait()
		await Bun.sleep(250)
		expect(f.parent.requests).toHaveLength(2)
		expect(f.parent.errors).toEqual([])
	} finally {
		compact.open()
		inspecting.open()
		await f.dispose()
	}
})

test.each(["aborted", "error"] as const)(
	"wait consumes a delegated %s rather than treating delivery interruption as observer failure",
	async (outcome) => {
		const childWait = gate()
		const f = await fixture({ childWait, childError: outcome === "error" })

		try {
			await f.send()
			await until(() => f.child.requests.length === 1)
			const waiting = f.wait()

			if (outcome === "aborted") await f.child.session.abort()
			else childWait.open()
			expect((await waiting).structuredContent).toMatchObject({ status: outcome })
			expect(
				workStatus({ sessionId: sessionIdSchema.parse(f.child.session.sessionId) }, undefined, familyPolicy),
			).toMatchObject({
				kind: "interrupted",
				origin: "delivery",
			})
			await Bun.sleep(300)
			expect(f.parent.requests).toHaveLength(0)
			expect(
				f.parent.session.sessionManager
					.getEntries()
					.filter((e) => e.type === "custom" && e.customType === COMPLETION_MARKER),
			).toMatchObject([{ data: { kind: "consumed", throughSequence: 1 } }])
		} finally {
			childWait.open()
			await f.dispose()
		}
	},
)

for (const outcome of ["error", "aborted"] as const) {
	test.each([
		["disappearance", "Messaging receiver disappeared"],
		["replacement", "Messaging receiver replaced or ambiguous"],
		["ambiguity", "Messaging receiver replaced or ambiguous"],
		["unreadable state", "Messaging work state is unreadable"],
	] as const)(
		`observer %s during a queued retry does not consume the previous child ${outcome}`,
		async (failure, reason) => {
			const childWait = gate(),
				inspected = gate(),
				inspecting = gate()

			const f = await fixture({ childWait, childError: outcome === "error", pollMs: 60000 })
			let duplicate: SessionMailbox | undefined

			try {
				await f.parent.session.prompt("parent work")
				const initial = f.child.session.prompt("first attempt")
				await until(() => f.child.requests.length === 1)

				if (outcome === "aborted") await f.child.session.abort()
				else childWait.open()
				await initial
				expect(readCompletion(getRun(f.prepared.handle))).toMatchObject({ sequence: 1, outcome })
				await f.send()

				const pending = workStatus(
					{ sessionId: sessionIdSchema.parse(f.child.session.sessionId) },
					undefined,
					familyPolicy,
				)

				expect(pending.kind).toBe("pending")

				if (pending.kind !== "pending") throw new Error("Retry is not queued")
				f.setInspection(async () => {
					inspected.open()
					await inspecting.promise
				})
				const waiting = f.wait()
				await inspected.promise

				switch (failure) {
					case "disappearance":
						await f.child.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" })
						break
					case "replacement":
						await f.child.session.reload()
						break
					case "ambiguity":
						duplicate = new SessionMailbox({
							sessionId: sessionIdSchema.parse(f.child.session.sessionId),
							sessionFile: f.child.session.sessionFile,
							cwd: f.child.root,
						})
						break
					case "unreadable state": {
						const endpoint = listEndpoints().find((e) => e.sessionId === f.child.session.sessionId)

						if (!endpoint) throw new Error("Missing child endpoint")
						writeFileSync(join(f.child.root, "session-messages", endpoint.instanceId, "state.json"), "invalid JSON")
						break
					}
				}

				expect(
					workStatus(
						{ sessionId: sessionIdSchema.parse(f.child.session.sessionId), instanceId: pending.instanceId },
						undefined,
						familyPolicy,
					),
				).toMatchObject({
					kind: "interrupted",
					origin: "observer",
					reason,
				})
				inspecting.open()
				const result = await waiting

				if (failure === "ambiguity" || failure === "unreadable state") {
					expect((await f.wait()).structuredContent).toMatchObject({ status: "error", error: reason })
				}

				const parentFile = f.parent.session.sessionFile

				if (!parentFile) throw new Error("Missing parent transcript")

				const markers = SessionManager.open(parentFile)
					.getEntries()
					.filter((e) => e.type === "custom" && e.customType === COMPLETION_MARKER)

				expect({ result: result.structuredContent, markers }).toMatchObject({
					result: { status: "error", error: reason },
					markers: [],
				})
				expect(f.child.requests).toHaveLength(1)
			} finally {
				childWait.open()
				inspecting.open()
				duplicate?.dispose()
				await f.dispose()
			}
		},
	)
}

test("long Unicode completion wakes the parent with a UTF-8 bounded notice and retained source", async () => {
	const f = await fixture({ answer: "界".repeat(10000) + "🦊".repeat(1000) })

	try {
		await f.child.session.prompt("long answer")
		await until(() => f.parent.requests.length === 1)
		await f.parent.session.waitForIdle()

		const notice = f.parent.session.sessionManager
			.getEntries()
			.find((e) => e.type === "custom_message" && e.customType === INCOMING)

		if (notice?.type !== "custom_message") throw new Error("Missing visible completion")
		const content = z.string().parse(notice.content)
		expect(notice.display).toBe(true)
		const details = notice.details
		const message = messageSchema.parse(details)
		expect(Buffer.byteLength(message.text)).toBeLessThanOrEqual(16384)
		expect(Buffer.byteLength(content)).toBeLessThanOrEqual(16384)
		expect(message.text).toContain("界".repeat(3000))
		expect(message.text).toContain("Truncated")
		expect(message.text).not.toContain("�")
		const fact = readCompletion(getRun(f.prepared.handle))
		expect(message.text).toContain(`Source: ${fact?.sessionFile} entry `)
		expect(content).not.toContain("Reply target:")
		await Bun.sleep(300)
		expect(f.parent.requests).toHaveLength(1)
		expect(f.parent.errors).toEqual([])
	} finally {
		await f.dispose()
	}
})

test("busy parent sees completion at the next steering opportunity before its final answer", async () => {
	const first = gate(),
		second = gate()

	const f = await fixture({
		parentSteps: [{ tool: true, wait: first.promise }, { tool: true, wait: second.promise }, {}],
	})

	try {
		const running = f.parent.session.prompt("parent work")
		await until(() => f.parent.requests.length === 1)
		await f.child.session.prompt("child task")
		await until(() => f.parent.session.agent.peekQueuedMessages().length > 0)
		first.open()
		await until(() => f.parent.requests.length === 2)
		expect(JSON.stringify(f.parent.requests[1])).toContain("answer-1")
		expect(f.parent.session.getLastAssistantText()).not.toBe("answer-3")
		second.open()
		await running
		await f.parent.session.waitForIdle()
		expect(f.parent.requests).toHaveLength(3)
		expect(
			f.parent.session.sessionManager
				.getEntries()
				.filter((e) => e.type === "custom_message" && e.customType === INCOMING),
		).toHaveLength(1)
		expect(f.parent.errors).toEqual([])
	} finally {
		first.open()
		second.open()
		await f.dispose()
	}
})

test.each([false, true])("background completion wakes once with no active tools, busy parent %s", async (busy) => {
	const hold = gate()
	const f = await fixture(busy ? { busy: hold } : {})

	try {
		const running = busy ? f.parent.session.prompt("parent work") : undefined

		if (busy) await until(() => f.parent.requests.length === 1)
		await f.child.session.prompt("child task")

		if (busy) {
			await until(() => f.parent.session.agent.peekQueuedMessages().length > 0)
			expect(f.parent.requests).toHaveLength(1)
			hold.open()
			await running
		}

		await until(() => f.parent.requests.length === (busy ? 2 : 1))
		await f.parent.session.waitForIdle()
		expect(f.parent.session.getActiveToolNames()).toEqual([])

		const notices = f.parent.session.sessionManager
			.getEntries()
			.filter((e) => e.type === "custom_message" && e.customType === INCOMING)

		expect(notices).toMatchObject([{ display: true, details: { route: { kind: "completion", sequence: 1 } } }])
		expect(JSON.stringify(notices)).toContain("entry ")
		await f.parent.session.reload()
		await Bun.sleep(300)
		expect(f.parent.requests).toHaveLength(busy ? 2 : 1)
		expect(f.parent.errors).toEqual([])
	} finally {
		hold.open()
		await f.dispose()
	}
})

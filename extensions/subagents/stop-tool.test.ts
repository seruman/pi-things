import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { acquireDelivery } from "../lib/session-delivery/runtime"
import { admissionSchema, listEndpoints, workStatus } from "../lib/session-delivery/mailbox"
import { sessionIdSchema } from "../lib/session-delivery/identity"
import { DIAGNOSTIC, INCOMING } from "../lib/session-delivery/ui"
import { sdk, testDirectory, until } from "../session-messages/fixtures/sdk"
import { gate } from "../session-messages/fixtures/provider"
import { installBridge } from "./bridge"
import { installParent } from "./index"
import { familyPolicy } from "./family"
import { getRun, prepareRun, runDirectory, writeMetadata } from "./runs"
import { requestStop, stopAcknowledged, stopRequested } from "./stop"
import { installPrivateChild } from "./private-child"
import { readCompletion } from "./completion"

test("agent_stop rejects unsubmitted private input while awaiting Rex close", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR
	const previousSession = process.env.REX_SESSION
	const root = testDirectory()
	process.env.PI_CODING_AGENT_DIR = root
	process.env.REX_SESSION = "test-session"
	const closeEntered = gate()
	const closeAllowed = gate()
	const calls: string[] = []

	const parent = await sdk({
		root,
		pool: false,
		steps: [{}],
		extension(pi) {
			const delivery = acquireDelivery(pi, { root: join(root, "session-messages"), pollMs: 5 })
			delivery.setFamilyPolicy(familyPolicy)
			installParent(
				{
					...pi,
					async exec(command, args) {
						if (command !== "rex") throw new Error(`Unexpected command ${command}`)

						if (args[0] === "block") {
							calls.push("process")

							return {
								code: 0,
								stdout: JSON.stringify({ last_exit: null }),
								stderr: "",
								killed: false,
								truncated: false,
							}
						}

						if (args[4] === "block.close") {
							calls.push("close requested")
							closeEntered.open()
							await closeAllowed.promise
							await child.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })
							calls.push("close completed")

							return {
								code: 0,
								stdout: JSON.stringify({ block_id: "test-block", revision: 1 }),
								stderr: "",
								killed: false,
								truncated: false,
							}
						}

						throw new Error(`Unexpected Rex operation ${args.join(" ")}`)
					},
				},
				undefined,
				delivery,
				() => () => {},
			)
		},
	})

	const parentSessionId = sessionIdSchema.parse(parent.session.sessionId)
	const prepared = prepareRun(parentSessionId)
	writeMetadata({
		...prepared,
		version: 1,
		parentSessionId,
		blockId: "test-block",
		cwd: root,
		provider: "session-message-test",
		model: "controlled",
		thinking: "off",
		launchArgs: [],
		accountingVersion: 1,
		createdAt: new Date().toISOString(),
	})
	const starts: string[] = []

	const child = await sdk({
		root,
		pool: false,
		steps: [{ text: "initial completed answer" }],
		extension(pi) {
			acquireDelivery(pi, { root: join(root, "session-messages"), pollMs: 1000 }).setFamilyPolicy(familyPolicy)
			installBridge(pi, runDirectory(prepared.handle))
			pi.on("before_agent_start", (event) => {
				starts.push(event.messageType)
			})
		},
	})

	const childSession = child.session

	const invoke = async (name: string, params: { handle: string; message?: string }) => {
		const tool = parent.session.extensionRunner.getToolDefinition(name)

		if (!tool) throw new Error(`Missing ${name}`)

		return tool.execute(
			name,
			params,
			undefined,
			undefined,
			parent.session.extensionRunner.createToolContext(name, undefined),
		)
	}

	let stopping: ReturnType<typeof invoke> | undefined

	try {
		await child.session.prompt("initial work")
		expect(readCompletion(getRun(prepared.handle))?.sequence).toBe(1)
		await invoke("agent_send", { handle: prepared.handle, message: "private work cancelled by stop" })
		stopping = invoke("agent_stop", { handle: prepared.handle })
		await closeEntered.promise
		expect(stopRequested(getRun(prepared.handle))).toBe(true)
		expect(stopAcknowledged(getRun(prepared.handle))).toBe(true)
		expect(starts).toEqual(["user"])
		await until(
			() =>
				starts.includes("custom") ||
				childSession.sessionManager
					.getEntries()
					.some(
						(entry) =>
							entry.type === "custom" &&
							entry.customType === DIAGNOSTIC &&
							JSON.stringify(entry.data).includes("Rejected unauthorized mailbox file"),
					),
		)
		await child.session.waitForIdle()
		closeAllowed.open()
		const result = await stopping
		const run = getRun(prepared.handle)
		const persisted = SessionManager.open(run.sessionFile)

		const incoming = persisted
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === INCOMING)

		expect(calls).toContain("close completed")
		expect(child.requests).toHaveLength(1)
		expect([...parent.errors, ...child.errors]).toEqual([])
		expect(run.stoppedAt).toBeDefined()
		expect(result.isError).not.toBe(true)
		expect(incoming).toHaveLength(0)
		expect(starts).toEqual(["user"])
		expect(readCompletion(run)).toMatchObject({ sequence: 1, outcome: "success" })
	} finally {
		closeAllowed.open()
		await stopping?.catch(() => {})
		await parent.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" })
		await child.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" })

		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
		else process.env.PI_CODING_AGENT_DIR = previous

		if (previousSession === undefined) delete process.env.REX_SESSION
		else process.env.REX_SESSION = previousSession
	}
})

async function lifecycleFixture(options: { compact?: boolean; blocked?: Promise<void> } = {}) {
	const previous = process.env.PI_CODING_AGENT_DIR
	const previousSession = process.env.REX_SESSION
	const root = testDirectory()
	const mailboxRoot = join(root, "session-messages")
	process.env.PI_CODING_AGENT_DIR = root
	process.env.REX_SESSION = "test-session"
	const closeEntered = gate()
	const closeAllowed = gate()
	const compactEntered = gate()
	const compactAllowed = gate()

	const parent = await sdk({
		root,
		pool: false,
		steps: [{ text: "parent received reply" }],
		extension(pi) {
			const delivery = acquireDelivery(pi, { root: mailboxRoot, pollMs: 5 })
			delivery.setFamilyPolicy(familyPolicy)
			installParent(
				{
					...pi,
					async exec(command, args) {
						if (command !== "rex") throw new Error(`Unexpected command ${command}`)

						if (args[0] === "block") {
							return {
								code: 0,
								stdout: JSON.stringify({ last_exit: null }),
								stderr: "",
								killed: false,
								truncated: false,
							}
						}

						if (args[4] !== "block.close") throw new Error(`Unexpected Rex operation ${args.join(" ")}`)
						closeEntered.open()
						await closeAllowed.promise
						await child.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })

						return {
							code: 0,
							stdout: JSON.stringify({ block_id: "test-block", revision: 1 }),
							stderr: "",
							killed: false,
							truncated: false,
						}
					},
				},
				undefined,
				delivery,
				() => () => {},
			)
		},
	})

	const parentSessionId = sessionIdSchema.parse(parent.session.sessionId)
	const prepared = prepareRun(parentSessionId)
	writeMetadata({
		...prepared,
		version: 1,
		parentSessionId,
		blockId: "test-block",
		cwd: root,
		provider: "session-message-test",
		model: "controlled",
		thinking: "off",
		launchArgs: [],
		accountingVersion: 1,
		createdAt: new Date().toISOString(),
	})

	const child = await sdk({
		root,
		pool: false,
		steps: options.blocked ? [{ wait: options.blocked }] : [{}, {}, {}],
		extension(pi) {
			const delivery = acquireDelivery(pi, { root: mailboxRoot, pollMs: 5 })
			delivery.setFamilyPolicy(familyPolicy)
			installBridge(pi, runDirectory(prepared.handle))
			installPrivateChild(pi, runDirectory(prepared.handle), delivery)

			if (options.compact) {
				pi.on("session_before_compact", async (event) => {
					compactEntered.open()
					await compactAllowed.promise

					return {
						compaction: {
							summary: "test summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}
				})
			}
		},
	})

	const invoke = async (
		session: typeof parent,
		name: string,
		params: { handle?: string; message?: string; followUp?: boolean },
	) => {
		const tool = session.session.extensionRunner.getToolDefinition(name)

		if (!tool) throw new Error(`Missing ${name}`)

		return tool.execute(
			name,
			params,
			undefined,
			undefined,
			session.session.extensionRunner.createToolContext(name, undefined),
		)
	}

	const admissions = () => {
		const endpoint = listEndpoints(mailboxRoot).find((item) => item.sessionId === child.session.sessionId)

		if (!endpoint) throw new Error("Missing child endpoint")

		return z
			.object({ admissions: z.record(admissionSchema) })
			.parse(JSON.parse(readFileSync(join(mailboxRoot, endpoint.instanceId, "state.json"), "utf8"))).admissions
	}

	const cleanup = async () => {
		compactAllowed.open()
		closeAllowed.open()
		await parent.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" })
		await child.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" })

		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
		else process.env.PI_CODING_AGENT_DIR = previous

		if (previousSession === undefined) delete process.env.REX_SESSION
		else process.env.REX_SESSION = previousSession
	}

	return {
		root,
		mailboxRoot,
		parent,
		child,
		prepared,
		invoke,
		admissions,
		closeEntered,
		closeAllowed,
		compactEntered,
		compactAllowed,
		cleanup,
	}
}

test("stop withdraws received delegation held by manual compaction", async () => {
	const f = await lifecycleFixture({ compact: true })
	let compacting: Promise<unknown> | undefined
	let stopping: Promise<unknown> | undefined

	try {
		await f.child.session.prompt("first")
		await f.child.session.prompt("second")
		compacting = f.child.session.compact()
		await f.compactEntered.promise
		await f.invoke(f.parent, "agent_send", { handle: f.prepared.handle, message: "held delegation" })
		await until(() => Object.values(f.admissions()).some((item) => item.kind === "queued"))
		stopping = f.invoke(f.parent, "agent_stop", { handle: f.prepared.handle })
		await until(() => stopRequested(getRun(f.prepared.handle)))
		f.compactAllowed.open()
		await compacting
		await until(() =>
			f.child.session.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === DIAGNOSTIC &&
						JSON.stringify(entry.data).includes("withdrawn because its route is no longer authorized"),
				),
		)
		await f.closeEntered.promise
		f.closeAllowed.open()
		await stopping
		const run = getRun(f.prepared.handle)
		expect(
			SessionManager.open(run.sessionFile)
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === INCOMING),
		).toHaveLength(0)
		expect(f.child.requests).toHaveLength(2)
		expect(readCompletion(run)).toMatchObject({ sequence: 2, outcome: "success" })
		expect([...f.parent.errors, ...f.child.errors]).toEqual([])
	} finally {
		f.compactAllowed.open()
		f.closeAllowed.open()
		await compacting?.catch(() => {})
		await stopping?.catch(() => {})
		await f.cleanup()
	}
})

test("a stale block latch allows delegation and a current latch allows replies", async () => {
	const f = await lifecycleFixture()

	try {
		await f.child.session.prompt("initial")
		const run = getRun(f.prepared.handle)
		requestStop({ ...run, blockId: "previous-block" })
		expect(stopRequested(run)).toBe(false)
		await f.invoke(f.parent, "agent_send", { handle: run.handle, message: "new block work" })
		await until(() => f.child.requests.length === 2)
		await f.child.session.waitForIdle()
		requestStop(run)
		expect(stopRequested(run)).toBe(true)
		await f.invoke(f.child, "agent_reply", { message: "reply while stopping" })
		await until(() => f.parent.requests.length === 1)
		await f.parent.session.waitForIdle()
		expect(
			f.parent.session.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === INCOMING &&
						JSON.stringify(entry).includes("reply while stopping"),
				),
		).toBe(true)
		expect(
			f.child.session.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === INCOMING &&
						JSON.stringify(entry).includes("new block work"),
				),
		).toBe(true)
		expect([...f.parent.errors, ...f.child.errors]).toEqual([])
	} finally {
		await f.cleanup()
	}
})

test("stop leaves submitted follow-up under Pi control and publishes cancellation", async () => {
	const blocked = gate()
	const f = await lifecycleFixture({ blocked: blocked.promise })
	let prompt: Promise<unknown> | undefined
	let stopping: Promise<unknown> | undefined

	try {
		prompt = f.child.session.prompt("long running work")
		await until(() => f.child.requests.length === 1)
		await f.invoke(f.parent, "agent_send", {
			handle: f.prepared.handle,
			message: "submitted follow-up",
			followUp: true,
		})
		await until(() => Object.values(f.admissions()).some((item) => item.kind === "submitted"))
		requestStop(getRun(f.prepared.handle))
		// Let the child's 5 ms delivery poll run several times with the stop request in place.
		await Bun.sleep(100)
		expect(Object.values(f.admissions()).some((item) => item.kind === "submitted")).toBe(true)
		expect(
			f.child.session.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === DIAGNOSTIC &&
						JSON.stringify(entry.data).includes("withdrawn"),
				),
		).toBe(false)
		expect(
			workStatus({ sessionId: sessionIdSchema.parse(f.child.session.sessionId) }, f.mailboxRoot, familyPolicy).kind,
		).toBe("pending")
		stopping = f.invoke(f.parent, "agent_stop", { handle: f.prepared.handle })
		await f.closeEntered.promise
		await prompt
		const completion = readCompletion(getRun(f.prepared.handle))
		expect(completion).toMatchObject({ sequence: 1, outcome: "aborted", childSessionId: f.child.session.sessionId })
		f.closeAllowed.open()
		await stopping
		expect(getRun(f.prepared.handle).stoppedAt).toBeDefined()
		expect([...f.parent.errors, ...f.child.errors]).toEqual([])
	} finally {
		blocked.open()
		f.closeAllowed.open()
		await prompt?.catch(() => {})
		await stopping?.catch(() => {})
		await f.cleanup()
	}
})

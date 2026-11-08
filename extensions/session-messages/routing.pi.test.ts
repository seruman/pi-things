import { relationIdSchema, sessionIdSchema } from "../lib/session-delivery/identity"
import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { InMemoryCredentialStore } from "@earendil-works/pi-ai"
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent"
import { SessionMailbox, listEndpoints, workStatus } from "../lib/session-delivery/mailbox"
import { acquireDelivery } from "../lib/session-delivery/runtime"
import subagents from "../subagents/index"
import { familyPolicy } from "../subagents/family"
import { prepareRun, runDirectory, updateMetadata, writeMetadata, type RunMetadata } from "../subagents/runs"
import { createSessionMessages } from "./index"
import { gate } from "./fixtures/provider"
import { sdk, testDirectory } from "./fixtures/sdk"

async function isolated(run: (root: string) => Promise<void>) {
	const saved = process.env.PI_CODING_AGENT_DIR
	const child = process.env.PI_SUBAGENT_RUN_DIR
	const root = testDirectory()
	process.env.PI_CODING_AGENT_DIR = root
	delete process.env.PI_SUBAGENT_RUN_DIR

	try {
		await run(root)
	} finally {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR
		else process.env.PI_CODING_AGENT_DIR = saved

		if (child === undefined) delete process.env.PI_SUBAGENT_RUN_DIR
		else process.env.PI_SUBAGENT_RUN_DIR = child
	}
}

function metadata(parent: string, child: string) {
	const parentSessionId = sessionIdSchema.parse(parent)
	const prepared = prepareRun(parentSessionId)

	const run = {
		...prepared,
		version: 1,
		parentSessionId,
		childSessionId: sessionIdSchema.parse(child),
		blockId: "never-call-rex",
		cwd: process.cwd(),
		provider: "unused",
		model: "unused",
		thinking: "off",
		launchArgs: [],
		createdAt: new Date().toISOString(),
	} satisfies RunMetadata

	writeMetadata(run)

	return run
}

test.each([true, false])(
	"separate public/subagent factories survive duplicate loads, /new and reload with no tools; public first %s",
	async (publicFirst) => {
		await isolated(async (root) => {
			const modelRuntime = await ModelRuntime.create({
				credentials: new InMemoryCredentialStore(),
				modelsPath: null,
				allowModelNetwork: false,
				refreshOnCreate: false,
			})

			const publicAdapter = createSessionMessages()
			const pair = publicFirst ? [publicAdapter, subagents] : [subagents, publicAdapter]
			const errors: unknown[] = []

			const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
				const services = await createAgentSessionServices({
					cwd,
					agentDir: root,
					modelRuntime,
					settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
					resourceLoaderOptions: {
						noExtensions: true,
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						noContextFiles: true,
						extensionFactories: [...pair, ...pair],
					},
				})

				return {
					...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, noTools: "all" })),
					services,
					diagnostics: services.diagnostics,
				}
			}

			const runtime = await createAgentSessionRuntime(createRuntime, {
				cwd: root,
				agentDir: root,
				sessionManager: SessionManager.create(root, join(root, "sessions")),
			})

			runtime.setRebindSession(async (session) => {
				await session.bindExtensions({
					onError: (error) => {
						errors.push(error)
					},
				})
			})

			try {
				await runtime.session.bindExtensions({
					onError: (error) => {
						errors.push(error)
					},
				})

				for (const transition of ["new", "reload"] as const) {
					const before = listEndpoints()[0]
					expect(listEndpoints()).toHaveLength(1)
					expect(runtime.session.getActiveToolNames()).toEqual([])
					const names = runtime.session.extensionRunner.getAllRegisteredTools().map((t) => t.definition.name)
					expect(names.filter((n) => n === "session_send")).toHaveLength(1)
					expect(names.filter((n) => n === "agent_send")).toHaveLength(1)
					await runtime.session.prompt("/session-messages join test")
					expect(listEndpoints()[0]?.membership?.pool).toBe("test")

					if (transition === "new") await runtime.newSession()
					else await runtime.session.reload()
					expect(listEndpoints()).toHaveLength(1)
					expect(listEndpoints()[0]?.instanceId).not.toBe(before?.instanceId)
					expect(listEndpoints()[0]?.membership).toBeUndefined()
					expect(runtime.session.getActiveToolNames()).toEqual([])
				}

				expect(errors).toEqual([])
			} finally {
				await runtime.dispose()
			}

			expect(listEndpoints()).toEqual([])
		})
	},
)

test("all private handle mutations and waits reject a foreign parent before external IO", async () => {
	await isolated(async (root) => {
		const h = await sdk({ root, pool: false, extension: subagents })

		try {
			const run = metadata("another-parent", "child")

			for (const name of ["agent_send", "agent_wait", "agent_stop", "agent_rename"]) {
				const tool = h.session.extensionRunner.getToolDefinition(name)

				if (!tool) throw new Error(`Missing ${name}`)
				await expect(
					tool.execute(
						"routing",
						{ handle: run.handle, message: "denied", name: "denied" },
						undefined,
						undefined,
						h.session.extensionRunner.createToolContext("routing", undefined),
					),
				).rejects.toThrow("belongs to another parent")
			}
		} finally {
			await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" })
		}
	})
})

test.each(["parent", "child", "file", "relation", "stopped", "suspended"] as const)(
	"family policy revokes send, receive and workStatus after %s changes",
	async (change) => {
		await isolated(async (root) => {
			const run = metadata("parent", "child")

			const parent = new SessionMailbox(
				{ sessionId: sessionIdSchema.parse("parent"), cwd: root },
				undefined,
				familyPolicy,
			)

			const child = new SessionMailbox(
				{ sessionId: sessionIdSchema.parse("child"), cwd: root, sessionFile: run.sessionFile },
				undefined,
				familyPolicy,
			)

			try {
				const delegate = {
					kind: "family",
					relation: run.relation,
					handle: run.handle,
					direction: "delegate",
				} as const

				const reply = { ...delegate, direction: "reply" } as const
				parent.send(sessionIdSchema.parse("child"), "authorized delegate", "steer", delegate)
				child.send(sessionIdSchema.parse("parent"), "authorized reply", "steer", reply)
				expect(workStatus({ sessionId: sessionIdSchema.parse("child") }, undefined, familyPolicy).kind).toBe("pending")
				expect(workStatus({ sessionId: sessionIdSchema.parse("parent") }, undefined, familyPolicy).kind).toBe("pending")

				const patches = {
					parent: { parentSessionId: sessionIdSchema.parse("foreign") },
					child: { childSessionId: sessionIdSchema.parse("foreign") },
					file: { sessionFile: join(root, "foreign.jsonl") },
					relation: { relation: relationIdSchema.parse(randomUUID()) },
					stopped: { stoppedAt: new Date().toISOString() },
					suspended: { suspended: true },
				} satisfies Record<typeof change, Partial<RunMetadata>>

				updateMetadata(runDirectory(run.handle), patches[change])
				expect(() => parent.send(sessionIdSchema.parse("child"), "denied", "steer", delegate)).toThrow("authorized")
				expect(() => child.send(sessionIdSchema.parse("parent"), "denied", "steer", reply)).toThrow("authorized")

				for (const mailbox of [parent, child]) {
					expect(workStatus({ sessionId: mailbox.endpoint.sessionId }, undefined, familyPolicy).kind).toBe("idle")
					expect(mailbox.receive(() => {})).toEqual([])
				}
			} finally {
				parent.dispose()
				child.dispose()
			}
		})
	},
)

test.each(["sender", "recipient"] as const)(
	"pool %s leave/rejoin revokes admitted work before submission",
	async (leaving) => {
		const root = testDirectory()
		const hold = gate()
		const started = gate()
		const extension = createSessionMessages({ root, pollMs: 5 })

		const recipient = await sdk({
			root,
			steps: [{}, {}],
			extension: async (pi) => {
				await extension(pi)
				pi.on("session_before_compact", async (event) => {
					started.open()
					await hold.promise

					return {
						compaction: {
							summary: "test summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}
				})
			},
		})

		const sender = await sdk({ root, extension })
		await recipient.session.prompt("first")
		await recipient.session.prompt("second")
		const compact = recipient.session.compact()

		try {
			await started.promise
			const tool = sender.session.extensionRunner.getToolDefinition("session_send")

			if (!tool) throw new Error("Missing public sender")
			await tool.execute(
				"routing",
				{ to: recipient.session.sessionId, message: "must never enter model input" },
				undefined,
				undefined,
				sender.session.extensionRunner.createToolContext("routing", undefined),
			)
			await Bun.sleep(30)
			expect(workStatus({ sessionId: sessionIdSchema.parse(recipient.session.sessionId) }, root).kind).toBe("pending")
			const member = leaving === "sender" ? sender : recipient
			await member.session.prompt("/session-messages leave")
			await member.session.prompt("/session-messages join test")
			expect(workStatus({ sessionId: sessionIdSchema.parse(recipient.session.sessionId) }, root).kind).toBe("idle")
		} finally {
			hold.open()
			await compact
		}

		await Bun.sleep(30)
		expect(recipient.requests).toHaveLength(2)
		expect(recipient.session.sessionManager.getBranch().filter((e) => e.type === "custom_message")).toHaveLength(0)
		expect(recipient.errors).toEqual([])
	},
)

test("family authorization is rechecked after compaction admission", async () => {
	await isolated(async (root) => {
		const hold = gate()
		const started = gate()

		const h = await sdk({
			root,
			pool: false,
			steps: [{}, {}],
			extension: (pi) => {
				acquireDelivery(pi, { pollMs: 5 }).setFamilyPolicy(familyPolicy)
				pi.on("session_before_compact", async (event) => {
					started.open()
					await hold.promise

					return {
						compaction: {
							summary: "test summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}
				})
			},
		})

		const run = metadata("parent", h.session.sessionId)
		updateMetadata(runDirectory(run.handle), { sessionFile: h.session.sessionFile })

		const parent = new SessionMailbox(
			{ sessionId: sessionIdSchema.parse("parent"), cwd: root },
			undefined,
			familyPolicy,
		)

		try {
			await h.session.prompt("first")
			await h.session.prompt("second")
			const compact = h.session.compact()

			try {
				await started.promise
				parent.send(sessionIdSchema.parse(h.session.sessionId), "revoked family input", "steer", {
					kind: "family",
					relation: run.relation,
					handle: run.handle,
					direction: "delegate",
				})
				await Bun.sleep(30)
				expect(
					workStatus({ sessionId: sessionIdSchema.parse(h.session.sessionId) }, undefined, familyPolicy).kind,
				).toBe("pending")
				updateMetadata(runDirectory(run.handle), { suspended: true })
				expect(
					workStatus({ sessionId: sessionIdSchema.parse(h.session.sessionId) }, undefined, familyPolicy).kind,
				).toBe("idle")
			} finally {
				hold.open()
				await compact
			}

			await Bun.sleep(30)
			expect(h.requests).toHaveLength(2)
			expect(h.session.sessionManager.getBranch().filter((e) => e.type === "custom_message")).toHaveLength(0)
			expect(h.errors).toEqual([])
		} finally {
			parent.dispose()
		}
	})
})

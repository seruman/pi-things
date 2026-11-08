import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryCredentialStore } from "@earendil-works/pi-ai"
import {
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionRuntimeFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "@earendil-works/pi-coding-agent"
import { sessionIdSchema } from "../lib/session-delivery/identity"
import { SessionMailbox, listEndpoints } from "../lib/session-delivery/mailbox"
import { controlledProvider } from "../session-messages/fixtures/provider"
import { managedParent, familyPolicy } from "./family"
import subagents from "./index"
import { isManagedChildLaunch } from "./parent-flags"
import { getRun, prepareRun, runDirectory, updateMetadata, writeMetadata } from "./runs"
import { requestStop, stopAcknowledged } from "./stop"

const selections: {
	name: string
	options: Pick<CreateAgentSessionFromServicesOptions, "tools" | "noTools" | "excludeTools">
	send: boolean
}[] = [
	{ name: "default", options: {}, send: true },
	{ name: "no tools", options: { noTools: "all" }, send: false },
	{ name: "no builtin tools", options: { noTools: "builtin" }, send: true },
	{ name: "readonly", options: { tools: ["read", "grep", "find", "ls"] }, send: false },
	{ name: "exclude send", options: { excludeTools: ["agent_reply"] }, send: false },
]

async function until(check: () => boolean) {
	const deadline = Date.now() + 5000

	while (!check()) {
		if (Date.now() > deadline) throw new Error("Lifecycle assertion timed out")
		await Bun.sleep(5)
	}
}

test.each(selections)("managed /new then reload retains bridge and restrictions: $name", async ({ options, send }) => {
	const root = mkdtempSync(join(tmpdir(), "subagent-launch-lifecycle-"))
	const savedArgv = process.argv

	const savedEnv = {
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		PI_SUBAGENT_RUN_DIR: process.env.PI_SUBAGENT_RUN_DIR,
	}

	process.env.PI_CODING_AGENT_DIR = root
	const prepared = prepareRun()
	const runDir = runDirectory(prepared.handle)
	process.env.PI_SUBAGENT_RUN_DIR = runDir
	process.argv = [process.execPath, "pi", "--session", prepared.sessionFile]
	writeMetadata({
		version: 1,
		...prepared,
		launchSessionFile: prepared.sessionFile,
		blockId: "no-rex-block",
		parentSessionId: sessionIdSchema.parse("parent"),
		cwd: root,
		provider: "unused",
		model: "unused",
		thinking: "off",
		launchArgs: [],
		createdAt: new Date().toISOString(),
	})
	const errors: unknown[] = []
	const received: string[] = []
	const inputs: string[] = []

	const parentMailbox = new SessionMailbox(
		{ sessionId: sessionIdSchema.parse("parent"), cwd: root },
		undefined,
		familyPolicy,
	)

	const aliasesBeforeBridge: (string | undefined)[] = []

	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	})

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
				extensionFactories: [
					(pi) => {
						pi.on("session_start", (_event, ctx) => {
							aliasesBeforeBridge.push(managedParent(ctx))
						})
						controlledProvider(pi, [{}], [])
						pi.on("input", (event) => {
							inputs.push(event.text)
						})
						pi.on("before_agent_start", (event) => {
							if (event.messageType === "custom") received.push(String(event.message.content))
						})
					},
					subagents,
				],
			},
		})

		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, ...options })),
			services,
			diagnostics: services.diagnostics,
		}
	}

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: root,
		agentDir: root,
		sessionManager: SessionManager.open(prepared.sessionFile, root, root),
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
		const initialId = runtime.session.sessionId
		await runtime.newSession()
		expect(runtime.session.sessionId).not.toBe(initialId)
		const currentFile = getRun(prepared.handle).sessionFile
		expect(runtime.session.sessionFile).toBe(currentFile)
		expect(currentFile).not.toBe(prepared.sessionFile)
		expect(getRun(prepared.handle)).toMatchObject({ sessionFile: currentFile, launchSessionFile: prepared.sessionFile })
		expect(aliasesBeforeBridge[1]).toBeUndefined()
		await runtime.session.reload()
		expect(isManagedChildLaunch(runDir, process.argv.slice(2), root)).toBe(true)
		expect(runtime.session.extensionRunner.getToolDefinition("agent_spawn")).toBeUndefined()
		expect(runtime.session.getActiveToolNames().includes("agent_reply")).toBe(send)

		if (options.noTools === "all") expect(runtime.session.getActiveToolNames()).toEqual([])

		if (options.tools) expect(runtime.session.getActiveToolNames().sort()).toEqual([...options.tools].sort())
		const ctx = runtime.session.extensionRunner.createContext()
		expect(managedParent(ctx)).toBe(sessionIdSchema.parse("parent"))
		updateMetadata(runDir, { childSessionId: sessionIdSchema.parse("unrelated") })
		expect(managedParent(ctx)).toBeUndefined()
		updateMetadata(runDir, {
			childSessionId: sessionIdSchema.parse(runtime.session.sessionId),
			sessionFile: prepared.sessionFile,
		})
		expect(managedParent(ctx)).toBeUndefined()
		updateMetadata(runDir, { sessionFile: currentFile })

		await modelRuntime.refresh({ allowNetwork: false })
		const model = modelRuntime.getModel("session-message-test", "controlled")

		if (!model) throw new Error("Missing controlled provider")
		await runtime.session.setModel(model)
		parentMailbox.send(sessionIdSchema.parse(runtime.session.sessionId), "after reload", "steer", {
			kind: "family",
			relation: prepared.relation,
			handle: prepared.handle,
			direction: "delegate",
		})
		await until(() => received.some((text) => text.includes("after reload")))
		await runtime.session.waitForIdle()
		expect(ctx.getSystemPrompt().includes("agent_reply")).toBe(send)
		expect(received.join("\n")).not.toContain("Reply target:")
		expect(inputs).toEqual([])
		expect(runtime.session.extensionRunner.getToolDefinition("session_send")).toBeUndefined()
		parentMailbox.join("parent-only")
		expect(
			listEndpoints(parentMailbox.root).find((e) => e.sessionId === runtime.session.sessionId)?.membership,
		).toBeUndefined()

		if (send) {
			const reply = runtime.session.extensionRunner.getToolDefinition("agent_reply")

			if (!reply) throw new Error("Missing private reply")
			await reply.execute(
				"question",
				{ message: "private question" },
				undefined,
				undefined,
				runtime.session.extensionRunner.createToolContext("question", undefined),
			)
			expect(parentMailbox.receive(() => {})).toMatchObject([
				{ text: "private question", route: { kind: "family", direction: "reply" } },
			])
		}

		expect(
			runtime.session.sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.display),
		).toHaveLength(1)
		requestStop(getRun(prepared.handle))
		await until(() => stopAcknowledged(getRun(prepared.handle)))
		expect(getRun(prepared.handle).launchSessionFile).toBe(prepared.sessionFile)

		process.argv = [process.execPath, "pi", "--session", join(root, "unrelated.jsonl")]
		await runtime.newSession()
		expect(runtime.session.extensionRunner.getToolDefinition("agent_spawn")).toBeDefined()
		expect(managedParent(runtime.session.extensionRunner.createContext())).toBeUndefined()
		expect(getRun(prepared.handle).sessionFile).toBe(currentFile)
		expect(errors).toEqual([])
	} finally {
		await runtime.dispose()
		parentMailbox.dispose()
		process.argv = savedArgv

		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}

		rmSync(root, { recursive: true, force: true })
	}
})

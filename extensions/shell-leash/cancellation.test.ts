import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	type AssistantMessage,
	InMemoryCredentialStore,
	Type,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai"
import { getModel } from "@earendil-works/pi-ai/compat"
import {
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
} from "@earendil-works/pi-coding-agent"
import { installBridge } from "../subagents/bridge"
import { getRun, prepareRun, runDirectory, updateMetadata, writeMetadata } from "../subagents/runs"
import shellLeash from "./index"

let root: string

let savedAgentDir: string | undefined

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "shell-leash-cancellation-"))
	savedAgentDir = process.env.PI_CODING_AGENT_DIR
	process.env.PI_CODING_AGENT_DIR = root
})

afterEach(() => {
	if (savedAgentDir === undefined) Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR")
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir

	rmSync(root, { recursive: true, force: true })
})

// Real Pi session, extension dispatch, nested tool dispatch and cancellation. No shell or provider runs.
test.each(["direct", "nested"])("denial cancels a real Pi run (%s), including queued follow-up work", async (route) => {
	const run = prepareRun()
	writeMetadata({
		...run,
		version: 1,
		blockId: "test-block",
		parentSessionId: "test-parent",
		cwd: root,
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		thinking: "off",
		launchArgs: [],
		createdAt: new Date().toISOString(),
	})
	const bridgeStates: (string | undefined)[] = []
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } })

	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	})

	await modelRuntime.setRuntimeApiKey("anthropic", "unused-test-key")

	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => installBridge(pi, runDirectory(run.handle)),
			shellLeash,
			// Match the installed legacy bridge, loaded after explicit CLI extensions.
			(pi) =>
				pi.on("agent_settled", (_event, ctx) => {
					bridgeStates.push(getRun(run.handle).state)

					if (ctx.isIdle()) updateMetadata(runDirectory(run.handle), { state: "idle" })
				}),
		],
	})

	await resourceLoader.reload()
	let executions = 0

	const { session } = await createAgentSession({
		cwd: root,
		agentDir: root,
		model: getModel("anthropic", "claude-sonnet-4-5"),
		modelRuntime,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.open(run.sessionFile, root, root),
		tools: ["bash", "nested"],
		customTools: [
			{
				name: "bash",
				label: "Fake bash",
				description: "Records execution without running a shell",
				parameters: Type.Object({ command: Type.String() }),
				async execute() {
					executions++

					return { content: [{ type: "text", text: "executed" }], details: {} }
				},
			},
			{
				name: "nested",
				label: "Nested call",
				description: "Calls bash through Pi's nested tool dispatch",
				parameters: Type.Object({}),
				async execute(_id, _args, _signal, _update, ctx) {
					await ctx.executeTool("bash", { command: "rm -f" })

					// Even swallowing the nested error must not let the model continue.
					return { content: [{ type: "text", text: "ignored denial" }], details: {} }
				},
			},
		],
	})

	try {
		await session.bindExtensions({ mode: "print" })
		let requests = 0
		const settled: boolean[] = []
		session.subscribe((event) => {
			if (event.type === "agent_settled") settled.push(event.aborted)
		})
		session.agent.streamFunction = (model, _context, options) => {
			options?.signal?.throwIfAborted()
			requests++

			const stopReason = requests === 1 ? "toolUse" : "stop"

			const response: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: Date.now(),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason,
				content:
					requests === 1
						? [
								{
									type: "toolCall",
									id: "denied",
									name: route === "direct" ? "bash" : "nested",
									arguments: route === "direct" ? { command: "rm -f" } : {},
								},
							]
						: [{ type: "text", text: "A new prompt works" }],
			}

			if (requests === 1) {
				session.agent.followUp({ role: "user", content: "Try another approach", timestamp: Date.now() })
			}

			const stream = createAssistantMessageEventStream()
			stream.push({ type: "done", reason: stopReason, message: response })

			return stream
		}

		await session.prompt("Attempt the guarded command")
		expect(executions).toBe(0)
		expect(requests).toBe(1)
		expect(settled).toEqual([true])
		expect(session.isIdle).toBe(true)
		expect(bridgeStates).toEqual(["error"])
		expect(getRun(run.handle)).toMatchObject({
			state: "idle",
			error: "shell-leash requires approval for: fs.rm, but no UI is available. The current run has been stopped.",
		})
		expect(session.sessionManager.getBranch()).toContainEqual(
			expect.objectContaining({
				type: "custom",
				customType: "shell-leash-denial",
				data: {
					reason: "shell-leash requires approval for: fs.rm, but no UI is available. The current run has been stopped.",
				},
			}),
		)

		// SDK abort leaves queued input pending; discard it before explicitly starting a fresh task.
		session.clearQueue()
		await session.prompt("New read-only task")
		expect(requests).toBe(2)
		expect(settled).toEqual([true, false])
		expect(getRun(run.handle).error).toBeUndefined()
	} finally {
		await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })
		session.dispose()
	}
})

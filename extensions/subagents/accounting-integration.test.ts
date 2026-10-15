import { expect, test } from "bun:test"
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
	createCodemodeExtension,
} from "@earendil-works/pi-coding-agent"
import { z } from "zod"
import { ATTRIBUTION_ENTRY, SOURCE_ENTRY, attributionSchema, sourceSchema } from "./accounting"
import type { ParentHost } from "./contracts"
import { installParent } from "./index"
import { getRun, runDirectory, updateMetadata } from "./runs"
import { childUsage, sumUsage } from "./usage"

// Real Pi + codemode + nested dispatch + persisted tool results. Only Rex and model
// streams are faked: no terminal processes, credentials, or network calls are used.
test.each([false, true])(
	"parallel codemode retains model costs and charges each source once (script fails: %s)",
	async (fails) => {
		const root = mkdtempSync(join(tmpdir(), "subagent-codemode-accounting-"))
		const savedDir = process.env.PI_CODING_AGENT_DIR
		const savedRex = process.env.REX_SESSION
		process.env.PI_CODING_AGENT_DIR = root
		process.env.REX_SESSION = "test-session"
		const blocks = new Map<string, string>()
		let blockCounter = 0

		const exec: ParentHost["exec"] = async (command, args) => {
			expect(command).toBe("rex")

			if (args[4] === "session.new_block") {
				const payload = z
					.object({ options: z.object({ command: z.array(z.string()) }), label: z.string() })
					.parse(JSON.parse(args[5]))

				const handle = payload.label.replace("subagent ", "")
				const argv = payload.options.command
				const path = z.string().parse(argv[argv.indexOf("--session") + 1])
				const model = z.string().parse(argv[argv.indexOf("--model") + 1])
				const tokens = model === "a" ? 5 : 7
				const child = SessionManager.open(path, root, root)
				child.appendMessage({ role: "user", content: "review", timestamp: Date.now() })
				child.appendMessage({
					role: "assistant",
					api: "openai-responses",
					provider: `actual-${model}`,
					model: `actual-${model}`,
					content: [{ type: "text", text: `answer-${model}` }],
					stopReason: "stop",
					timestamp: Date.now(),
					usage: {
						input: tokens,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: tokens,
						cost: { input: tokens / 100, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens / 100 },
					},
				})
				const blockId = `block:${++blockCounter}`
				blocks.set(blockId, handle)

				return { code: 0, stderr: "", stdout: JSON.stringify({ block_id: blockId, revision: 1 }), killed: false }
			}

			if (args[0] === "block") {
				const handle = blocks.get(args[3])

				if (!handle) return { code: 1, stderr: `Error: block target "${args[3]}" not found`, stdout: "", killed: false }
				updateMetadata(runDirectory(handle), { state: "idle", hasStarted: true })

				return { code: 0, stderr: "", stdout: JSON.stringify({ last_exit: null }), killed: false }
			}

			if (args[4] === "block.close") {
				const { block_id } = z.object({ block_id: z.string() }).parse(JSON.parse(args[5]))
				blocks.delete(block_id)

				return { code: 0, stderr: "", stdout: JSON.stringify({ block_id, revision: 1 }), killed: false }
			}

			throw new Error(`Unexpected Rex operation: ${args.join(" ")}`)
		}

		try {
			const settingsManager = SettingsManager.inMemory({
				defaultTools: ["codemode"],
				compaction: { enabled: false },
				retry: { enabled: false },
			})

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
					(pi) => {
						installParent({ ...pi, exec })
						pi.registerTool({
							name: "native_cost_probe",
							label: "Native cost probe",
							description: "Unrelated nested tool usage",
							exposure: "codemode",
							parameters: Type.Object({}),
							async execute() {
								return {
									content: [{ type: "text", text: "probe" }],
									details: undefined,
									usage: {
										input: 3,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										totalTokens: 3,
										cost: { input: 0.03, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
									},
								}
							},
						})
					},
					createCodemodeExtension({ mode: "on" }),
				],
			})

			await resourceLoader.reload()

			const { session } = await createAgentSession({
				cwd: root,
				agentDir: root,
				model: getModel("anthropic", "claude-sonnet-4-5"),
				modelRuntime,
				settingsManager,
				resourceLoader,
				sessionManager: SessionManager.create(root, root),
			})

			try {
				await session.bindExtensions({ mode: "print" })
				let requests = 0
				session.agent.streamFunction = (model) => {
					requests++

					const code =
						requests === 1
							? `
					await tools.native_cost_probe({});
					const answers = await Promise.all(["a", "b"].map(async model => {
						const run = await tools.agent_spawn({prompt: "review", model, background: true});
						const result = await tools.agent_wait({handle: run.handle});
						await tools.agent_wait({handle: run.handle});
						await tools.agent_stop({handle: run.handle});
						return result.answer;
					}));
					text(answers);
					${fails ? 'throw new Error("planned script failure");' : ""}
				`
							: "text((await tools.agent_list({includeStopped: true})).runs.length);"

					const stopReason = requests % 2 === 1 ? "toolUse" : "stop"

					const response: AssistantMessage = {
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						timestamp: Date.now(),
						stopReason,
						usage: {
							input: 1,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 1,
							cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
						},
						content:
							stopReason === "toolUse"
								? [{ type: "toolCall", id: `provider/batch-${requests}`, name: "codemode", arguments: { code } }]
								: [{ type: "text", text: "Done" }],
					}

					const stream = createAssistantMessageEventStream()
					stream.push({ type: "done", reason: stopReason, message: response })

					return stream
				}

				await session.prompt("Review in parallel and print only answers")
				const entries = session.sessionManager.getEntries()
				const result = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult")
				expect(result).toMatchObject({
					type: "message",
					message: { toolName: "codemode", isError: fails, usage: { totalTokens: 15 } },
				})

				const sources = entries.flatMap((entry) =>
					entry.type === "custom" && entry.customType === SOURCE_ENTRY ? [sourceSchema.parse(entry.data)] : [],
				)

				expect(sources).toHaveLength(2)
				expect(sources.map((source) => source.provider).sort()).toEqual(["actual-a", "actual-b"])

				const attributions = entries.flatMap((entry) =>
					entry.type === "custom" && entry.customType === ATTRIBUTION_ENTRY
						? [attributionSchema.parse(entry.data)]
						: [],
				)

				expect(attributions).toEqual([
					expect.objectContaining({
						accounting: "attribution-only",
						toolCallId: "provider/batch-1",
						toolResultEntryId: result?.id,
					}),
				])

				const attributedSources = attributions[0].sourceKeys.map((key) =>
					sources.find((source) => source.sourceKey === key),
				)

				expect(attributedSources).toHaveLength(2)
				expect(attributedSources).not.toContain(undefined)
				expect(
					attributedSources.map((source) => [source?.provider, source?.model, source?.usage.cost.total]).sort(),
				).toEqual([
					["actual-a", "actual-a", 0.05],
					["actual-b", "actual-b", 0.07],
				])
				expect(sumUsage(attributedSources.map((source) => source?.usage)).totalTokens).toBe(12)
				// Native Pi counts parent (2), subagents (12), and unrelated nested usage (3),
				// without understanding any of our custom records or double-counting their costs.
				expect(session.getSessionStats().tokens.total).toBe(17)
				expect(session.getSessionStats().cost).toBeCloseTo(0.17)
				expect(blocks.size).toBe(0)

				for (const source of sources) expect(getRun(source.handle).stoppedAt).toBeString()
				await session.prompt("List the retained histories")
				expect(session.getSessionStats().tokens.total).toBe(19)
				const persisted = SessionManager.open(z.string().parse(session.sessionManager.getSessionFile()))
				expect(
					persisted.getEntries().filter((entry) => entry.type === "custom" && entry.customType === SOURCE_ENTRY),
				).toHaveLength(2)
				expect(
					persisted.getEntries().filter((entry) => entry.type === "custom" && entry.customType === ATTRIBUTION_ENTRY),
				).toHaveLength(1)
				const nativeOnly = childUsage(persisted.getEntries().filter((entry) => entry.type !== "custom"))
				expect(nativeOnly.totalTokens).toBe(19)
				expect(nativeOnly.cost.total).toBeCloseTo(0.19)
			} finally {
				await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })
				session.dispose()
			}
		} finally {
			if (savedDir === undefined) Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR")
			else process.env.PI_CODING_AGENT_DIR = savedDir

			if (savedRex === undefined) Reflect.deleteProperty(process.env, "REX_SESSION")
			else process.env.REX_SESSION = savedRex
			rmSync(root, { recursive: true, force: true })
		}
	},
)

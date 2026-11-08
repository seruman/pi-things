import { afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { InMemoryCredentialStore, type TranscriptContext } from "@earendil-works/pi-ai"
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionFactory,
	type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent"
import { controlledProvider, type Step } from "./provider"

const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

export function testDirectory() {
	const root = mkdtempSync(join(tmpdir(), "session-messages-test-"))
	cleanups.push(() => rmSync(root, { recursive: true, force: true }))

	return root
}

export async function until(check: () => boolean) {
	const deadline = Date.now() + 5000

	while (!check()) {
		if (Date.now() > deadline) throw new Error("Condition did not become true")
		await Bun.sleep(5)
	}
}

export async function sdk(
	options: {
		root?: string
		selectModel?: boolean
		pool?: string | false
		steps?: Step[]
		extension?: ExtensionFactory
		selection?: Pick<CreateAgentSessionOptions, "tools" | "noTools" | "excludeTools">
	} = {},
) {
	const root = options.root ?? testDirectory()
	const agentDir = join(root, "agent")
	mkdirSync(agentDir, { recursive: true })
	const requests: TranscriptContext[] = []
	const steps = options.steps ?? []
	let api: ExtensionAPI | undefined
	const errors: unknown[] = []

	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	})

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false, keepRecentTokens: 0 },
		retry: { enabled: false },
		cacheWarming: "off",
	})

	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "Isolated messaging test.",
		extensionFactories: [
			(pi) => {
				api = pi
				controlledProvider(pi, steps, requests)
			},
			...(options.extension ? [options.extension] : []),
		],
	})

	await loader.reload()

	if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors))

	const { session } = await createAgentSession({
		cwd: root,
		agentDir,
		modelRuntime: runtime,
		resourceLoader: loader,
		settingsManager,
		sessionManager: SessionManager.create(root, join(root, "sessions")),
		noTools: "builtin",
		...options.selection,
	})

	await session.bindExtensions({
		onError: (error) => {
			errors.push(error)
		},
	})
	await runtime.refresh({ allowNetwork: false })
	const model = runtime.getModel("session-message-test", "controlled")

	if (!model || !api) {
		throw new Error(
			`Fixture did not load: ${JSON.stringify({ errors, api: !!api, models: runtime.getModels().filter((m) => m.provider === "session-message-test") })}`,
		)
	}

	if (options.selectModel !== false) await session.setModel(model)

	if (options.pool !== false && session.extensionRunner.getToolDefinition("session_send")) {
		await session.prompt(`/session-messages join ${options.pool ?? "test"}`)
	}

	cleanups.push(async () => {
		await session.abort()
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })
		session.dispose()
	})

	return { session, api, requests, steps, errors, root }
}

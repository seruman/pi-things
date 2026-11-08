import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { InMemoryCredentialStore } from "@earendil-works/pi-ai"
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	parseArgs,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent"
import { listEndpoints } from "../lib/session-delivery/mailbox"
import subagents from "../subagents/index"
import { createSessionMessages } from "./index"
import { controlledProvider } from "./fixtures/provider"
import { testDirectory } from "./fixtures/sdk"

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function launch(args: string[], publicFirst = true) {
	const root = testDirectory()
	const saved = process.env.PI_CODING_AGENT_DIR
	const child = process.env.PI_SUBAGENT_RUN_DIR
	process.env.PI_CODING_AGENT_DIR = root
	delete process.env.PI_SUBAGENT_RUN_DIR
	const errors: unknown[] = []
	const diagnostics: unknown[] = []
	const factoryFlags: unknown[] = []
	const statuses: [string, string | undefined][] = []

	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	})

	const publicAdapter = createSessionMessages()
	const pair = publicFirst ? [publicAdapter, subagents] : [subagents, publicAdapter]

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: root,
			modelRuntime,
			extensionFlagValues: parseArgs(args).unknownFlags,
			settingsManager: SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false } }),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [
					...pair,
					...pair,
					(pi) => {
						factoryFlags.push(pi.getFlag("session-pool"))
						controlledProvider(pi, [], [])
					},
				],
			},
		})

		diagnostics.push(...services.diagnostics)

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

	cleanups.push(async () => {
		try {
			await runtime.dispose()
		} finally {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR
			else process.env.PI_CODING_AGENT_DIR = saved

			if (child === undefined) delete process.env.PI_SUBAGENT_RUN_DIR
			else process.env.PI_SUBAGENT_RUN_DIR = child
		}
	})

	const bind = async () => {
		await runtime.session.bindExtensions({
			uiContext: {
				...runtime.session.extensionRunner.getUIContext(),
				setStatus: (key, text) => statuses.push([key, text]),
			},
			mode: "rpc",
			onError: (error) => errors.push(error),
		})
	}

	runtime.setRebindSession(bind)
	await bind()

	return {
		runtime,
		errors,
		diagnostics,
		factoryFlags,
		statuses,
		modelRuntime,
		endpoint: () => {
			const endpoints = listEndpoints(join(root, "session-messages"))
			expect(endpoints).toHaveLength(1)

			return endpoints[0]!
		},
	}
}

for (const publicFirst of [true, false]) {
	test.each([undefined, "r", "Review_1.2-3", "x".repeat(64), "", "x".repeat(65), " review", "review ", "bad/name"])(
		`real SDK flag validation with duplicate adapters, public first ${publicFirst}, value %j`,
		async (pool) => {
			const h = await launch(pool === undefined ? [] : ["--session-pool", pool], publicFirst)
			const valid = pool !== undefined && ["r", "Review_1.2-3", "x".repeat(64)].includes(pool)
			expect(h.endpoint().membership?.pool).toBe(valid ? pool : undefined)
			expect(h.statuses.at(-1)).toEqual(["session-messages", valid ? `scope: pool/${pool}` : "scope: private"])
			expect(h.factoryFlags).toEqual([undefined])
			expect(h.diagnostics).toEqual([])
			expect(h.runtime.session.extensionRunner.getFlagValues().get("session-pool")).toBe(pool)
			expect(h.errors).toHaveLength(pool !== undefined && !valid ? 1 : 0)

			if (h.errors.length) expect(JSON.stringify(h.errors)).toContain("Invalid --session-pool")
		},
	)

	test(`launch flag reapplies on reload/new/resume, not ticks or prompts, public first ${publicFirst}`, async () => {
		const h = await launch(["--session-pool=review"], publicFirst)
		const { runtime } = h
		const original = h.endpoint()
		expect(original.membership?.pool).toBe("review")
		await runtime.session.prompt("/session-messages leave")
		await Bun.sleep(250)
		expect(h.endpoint().membership).toBeUndefined()
		await h.modelRuntime.refresh({ allowNetwork: false })
		const model = h.modelRuntime.getModel("session-message-test", "controlled")

		if (!model) throw new Error("Missing controlled provider")
		await runtime.session.setModel(model)
		await runtime.session.prompt("No automatic rejoin")
		expect(h.endpoint().membership).toBeUndefined()
		const file = runtime.session.sessionFile

		if (!file) throw new Error("Expected persistent session")
		const generations = new Set([original.membership?.generation])
		const instances = new Set([original.instanceId])

		for (const transition of ["reload", "new", "resume"] as const) {
			await runtime.session.prompt("/session-messages join manual")
			expect(h.endpoint().membership?.pool).toBe("manual")

			if (transition === "reload") await runtime.session.reload()
			else if (transition === "new") await runtime.newSession()
			else await runtime.switchSession(file)
			const endpoint = h.endpoint()
			expect(h.statuses.at(-1)).toEqual(["session-messages", "scope: pool/review"])
			expect(endpoint.membership?.pool).toBe("review")
			expect(generations.has(endpoint.membership?.generation)).toBe(false)
			expect(instances.has(endpoint.instanceId)).toBe(false)
			generations.add(endpoint.membership?.generation)
			instances.add(endpoint.instanceId)
		}

		expect(h.errors).toEqual([])
		expect(h.diagnostics).toEqual([])
		expect(h.factoryFlags.every((value) => value === undefined)).toBe(true)
	})
}

test("without a launch flag, manual membership is lost on reload and new", async () => {
	const h = await launch([])

	for (const transition of ["reload", "new"] as const) {
		await h.runtime.session.prompt("/session-messages join manual")
		expect(h.endpoint().membership?.pool).toBe("manual")

		if (transition === "reload") await h.runtime.session.reload()
		else await h.runtime.newSession()
		expect(h.endpoint().membership).toBeUndefined()
	}

	expect(h.errors).toEqual([])
})

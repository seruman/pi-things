import { expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai"
import {
	createAgentSession,
	DefaultResourceLoader,
	loadSkills,
	parseFrontmatter,
	SessionManager,
} from "@earendil-works/pi-coding-agent"
import manifest from "../../package.json"
import { createPotetoExtension } from "./index"
import { gate } from "../session-messages/fixtures/provider"
import { sdk, testDirectory, until } from "../session-messages/fixtures/sdk"

async function harness(options: { root?: string; agentDir?: string; pstackDir?: string } = {}) {
	const root = options.root ?? testDirectory()
	const statuses = new Map<string, string | undefined>()
	const notices: string[] = []

	const h = await sdk({
		root,
		extension: createPotetoExtension({
			agentDir: options.agentDir ?? join(root, "agent"),
			pstackDir: options.pstackDir,
		}),
		defaultPrompt: true,
		status: (key, text) => statuses.set(key, text),
	})

	const unsupportedNavigation = async () => {
		throw new Error("Unexpected session replacement in toggle test")
	}

	await h.session.bindExtensions({
		uiContext: { ...h.session.extensionRunner.getUIContext(), notify: (message) => notices.push(message) },
		mode: "rpc",
		commandContextActions: {
			waitForIdle: () => h.session.waitForIdle(),
			reload: () => h.session.reload(),
			navigateTree: (targetId, options) => h.session.navigateTree(targetId, options),
			newSession: unsupportedNavigation,
			fork: unsupportedNavigation,
			switchSession: unsupportedNavigation,
		},
	})

	return {
		...h,
		statuses,
		notices,
		async prompt() {
			h.steps.push({})
			await h.session.prompt("A test task")
			const request = h.requests.at(-1)

			if (!request) throw new Error("Expected a provider request")
			expect(h.errors).toEqual([])

			return getCurrentSystemPrompt(request.messages)
		},
	}
}

test("the package registers the directory extension but does not statically discover its vendor skills", () => {
	const root = testDirectory()

	const { skills } = loadSkills({
		cwd: root,
		agentDir: root,
		skillPaths: manifest.pi.skills.map((path) => resolve(path)),
		includeDefaults: false,
	})

	expect(manifest.pi.extensions).toContain("./extensions/poteto/index.ts")
	expect(skills.some((skill) => skill.filePath.startsWith(resolve("extensions/poteto/vendor")))).toBe(false)
	expect(skills.map((skill) => skill.name)).not.toContain("poteto-mode")
})

test("off by default; toggling injects local adapter and full skill on every task, without duplicate sections", async () => {
	const h = await harness()
	const tools = h.session.getActiveToolNames()
	const skillFile = resolve("extensions/poteto/vendor/pstack/skills/poteto-mode/SKILL.md")
	const adapter = readFileSync("extensions/poteto/vendor/pstack/ADAPTER.md", "utf8").trim()
	const body = parseFrontmatter(readFileSync(skillFile, "utf8")).body.trim()
	expect(await h.prompt()).not.toContain("<poteto-mode>")
	expect(h.session.resourceLoader.getSkills().skills).toHaveLength(0)
	await h.session.prompt("/poteto")
	expect(h.statuses.get("poteto")).toBe("poteto:on")
	const skills = h.session.resourceLoader.getSkills().skills
	expect(skills.map((skill) => skill.name)).toContain("poteto-mode")
	expect(skills.map((skill) => skill.name)).toContain("swarm")
	expect(skills.flatMap((skill) => (skill.disableModelInvocation ? [] : [skill.name])).sort()).toEqual([
		"blast-radius",
		"deslop",
		"how",
		"typescript-best-practices",
		"unslop",
	])

	for (let task = 0; task < 2; task++) {
		const prompt = await h.prompt()
		expect(prompt).toContain(adapter)
		expect(prompt).toContain(body)
		expect(prompt).toContain(skillFile)
		expect(prompt).not.toContain("disable-model-invocation: true")
		expect(prompt.split("<poteto-mode>")).toHaveLength(2)
	}

	await h.session.prompt("/poteto")
	expect(h.statuses.get("poteto")).toBeUndefined()
	expect(await h.prompt()).not.toContain("<poteto-mode>")
	expect(h.session.getActiveToolNames()).toEqual(tools)
	expect(h.session.resourceLoader.getSkills().skills).toHaveLength(0)
})

test("a busy session rejects toggles without changing mode or skill discovery", async () => {
	const h = await harness()
	const hold = gate()
	h.steps.push({ wait: hold.promise })
	const running = h.session.prompt("Hold this task")

	try {
		await until(() => h.requests.length === 1)
		await h.session.prompt("/poteto")
		expect(h.notices.join("\n")).toContain("Wait for the current task")
		expect(h.session.resourceLoader.getSkills().skills).toHaveLength(0)
		expect(
			h.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "poteto-mode"),
		).toBe(false)
	} finally {
		hold.open()
		await running
	}

	await h.session.prompt("/poteto")
	expect(await h.prompt()).toContain("<poteto-mode>")
})

test("on/off are explicit, unknown arguments do not toggle, and reload restores the session choice", async () => {
	const h = await harness()
	await h.session.prompt("/poteto on")
	await h.session.prompt("/poteto on")
	await h.prompt()
	await h.session.reload()
	expect(await h.prompt()).toContain("<poteto-mode>")
	await h.session.prompt("/poteto update")
	expect(await h.prompt()).toContain("<poteto-mode>")
	await h.session.prompt("/poteto off")
	await h.session.reload()
	expect(await h.prompt()).not.toContain("<poteto-mode>")
})

test("a newly loaded file-based extension resumes enabled mode from the saved session", async () => {
	const h = await harness()
	await h.session.prompt("/poteto on")
	await h.prompt()
	const file = h.session.sessionFile

	if (!file) throw new Error("Expected a saved session")
	const agentDir = join(h.root, "agent")

	const loader = new DefaultResourceLoader({
		cwd: h.root,
		agentDir,
		settingsManager: h.session.settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: [resolve("extensions/poteto/index.ts")],
	})

	await loader.reload()
	expect(loader.getExtensions().errors).toEqual([])

	const { session } = await createAgentSession({
		cwd: h.root,
		agentDir,
		modelRuntime: h.session.modelRuntime,
		model: h.session.model,
		resourceLoader: loader,
		settingsManager: h.session.settingsManager,
		sessionManager: SessionManager.open(file),
		noTools: "all",
	})

	try {
		await session.bindExtensions({ onError: (error) => h.errors.push(error) })
		h.steps.push({})
		await session.prompt("Resumed task")
		expect(h.requests).toHaveLength(2)
		const request = h.requests.at(-1)

		if (!request) throw new Error("Expected resumed provider request")
		expect(getCurrentSystemPrompt(request.messages)).toContain("<poteto-mode>")
		expect(h.errors).toEqual([])
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })
		session.dispose()
	}
})

test("the session-wide toggle stays off across tree navigation and reload", async () => {
	const h = await harness()
	await h.session.prompt("/poteto on")
	await h.prompt()
	const onLeaf = h.session.sessionManager.getLeafId()

	if (!onLeaf) throw new Error("Expected enabled branch")
	await h.session.prompt("/poteto off")
	await h.prompt()
	await h.session.navigateTree(onLeaf, { summarize: false })
	expect(h.statuses.get("poteto")).toBeUndefined()
	expect(await h.prompt()).not.toContain("<poteto-mode>")
	await h.session.reload()
	expect(await h.prompt()).not.toContain("<poteto-mode>")
	expect(h.session.resourceLoader.getSkills().skills).toHaveLength(0)
})

test("folder defaults apply to new sessions and descendants, but session off survives reload", async () => {
	const root = testDirectory()
	const agentDir = join(root, "agent")
	const h = await harness({ root, agentDir })
	await h.session.prompt("/poteto repo")
	expect(await h.prompt()).toContain("<poteto-mode>")
	const nested = await harness({ root: join(root, "nested"), agentDir })
	expect(await nested.prompt()).toContain("<poteto-mode>")
	await nested.session.prompt("/poteto off")
	await nested.session.reload()
	expect(await nested.prompt()).not.toContain("<poteto-mode>")
	const fresh = await harness({ root: join(root, "nested"), agentDir })
	expect(await fresh.prompt()).toContain("<poteto-mode>")
})

test("turning off a nested folder default leaves its parent and siblings enabled", async () => {
	const root = testDirectory()
	const agentDir = join(root, "agent")
	const parent = await harness({ root, agentDir })
	await parent.session.prompt("/poteto repo")
	const nested = await harness({ root: join(root, "nested"), agentDir })
	await nested.session.prompt("/poteto repo")
	const freshNested = await harness({ root: join(root, "nested", "deeper"), agentDir })
	expect(await freshNested.prompt()).not.toContain("<poteto-mode>")
	const sibling = await harness({ root: join(root, "sibling"), agentDir })
	expect(await sibling.prompt()).toContain("<poteto-mode>")
	const freshParent = await harness({ root, agentDir })
	expect(await freshParent.prompt()).toContain("<poteto-mode>")
})

test("managed subagents ignore folder defaults and cannot turn on automatic injection", async () => {
	const root = testDirectory()
	const agentDir = join(root, "agent")
	const parent = await harness({ root, agentDir })
	await parent.session.prompt("/poteto repo")
	const previous = process.env.PI_SUBAGENT_RUN_DIR
	process.env.PI_SUBAGENT_RUN_DIR = join(root, "child")

	try {
		const child = await harness({ root, agentDir })
		await child.session.prompt("/poteto on")
		expect(await child.prompt()).not.toContain("<poteto-mode>")
		expect(child.statuses.get("poteto")).toBeUndefined()
		expect(child.session.resourceLoader.getSkills().skills).toHaveLength(0)
		expect(child.notices.join("\n")).toContain("parent's brief")
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_RUN_DIR
		else process.env.PI_SUBAGENT_RUN_DIR = previous
	}
})

test("missing vendored files report an error without saving enabled state", async () => {
	const root = testDirectory()
	const h = await harness({ root, pstackDir: join(root, "missing") })
	await h.session.prompt("/poteto on")
	expect(h.notices.join("\n")).toContain("ADAPTER.md")
	expect(h.statuses.get("poteto")).toBeUndefined()
	expect(
		h.session.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "poteto-mode"),
	).toBe(false)
	expect(await h.prompt()).not.toContain("<poteto-mode>")
})

test("injection rereads vendored files and removes stale instructions if they disappear", async () => {
	const root = testDirectory()
	const pstackDir = join(root, "pstack")
	const skillDir = join(pstackDir, "skills", "poteto-mode")
	mkdirSync(skillDir, { recursive: true })
	writeFileSync(join(pstackDir, "ADAPTER.md"), "Local adapter")
	const skillFile = join(skillDir, "SKILL.md")
	writeFileSync(skillFile, "---\nname: poteto-mode\ndescription: Test skill\n---\nFirst skill instructions")
	const h = await harness({ root, pstackDir })
	await h.session.prompt("/poteto on")
	expect(await h.prompt()).toContain("First skill instructions")
	writeFileSync(skillFile, "---\nname: poteto-mode\ndescription: Test skill\n---\nUpdated skill instructions")
	const updated = await h.prompt()
	expect(updated).toContain("Updated skill instructions")
	expect(updated).not.toContain("First skill instructions")
	rmSync(skillFile)
	expect(await h.prompt()).not.toContain("<poteto-mode>")
	expect(h.statuses.get("poteto")).toBe("poteto:error")
	expect(h.notices.join("\n")).toContain("SKILL.md")
	writeFileSync(skillFile, "---\nname: poteto-mode\ndescription: Test skill\n---\nRecovered instructions")
	expect(await h.prompt()).toContain("Recovered instructions")
	expect(h.statuses.get("poteto")).toBe("poteto:on")
})

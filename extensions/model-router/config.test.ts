import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configSchema, loadConfig } from "./config"

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const mixed = {
	tiers: {
		trivial: { provider: "local", model: "open-model", thinking: "off" },
		standard: { provider: "openai-codex", model: "gpt-6.1-sol", thinking: "medium" },
		strong: { provider: "amazon-bedrock", model: "global.anthropic.claude-opus-5-5", thinking: "high" },
	},
} as const

function tempFile() {
	const root = mkdtempSync(join(tmpdir(), "model-router-config-"))
	roots.push(root)
	return join(root, "model-router.json")
}

describe("router configuration", () => {
	test("missing file and empty configuration both provide the two complete presets", () => {
		const config = loadConfig(tempFile())
		expect(config).toEqual(configSchema.parse({}))
		expect(Object.keys(config.routers)).toEqual(["codex", "bedrock"])
		expect(config.routers.codex.tiers).toEqual({
			trivial: { provider: "openai-codex", model: "gpt-6-luna", thinking: "low" },
			standard: { provider: "openai-codex", model: "gpt-6.1-sol", thinking: "medium" },
			strong: { provider: "openai-codex", model: "gpt-6-astra", thinking: "high" },
		})
		expect(config.routers.bedrock.tiers).toEqual({
			trivial: { provider: "amazon-bedrock", model: "global.anthropic.claude-haiku-5-5", thinking: "low" },
			standard: { provider: "amazon-bedrock", model: "global.anthropic.claude-sonnet-5-5", thinking: "medium" },
			strong: { provider: "amazon-bedrock", model: "global.anthropic.claude-opus-5-5", thinking: "high" },
		})
		expect(config.classifier).toEqual({
			baseUrl: "http://127.0.0.1:11434/v1",
			model: "clef-flash:9b-mxfp8",
			timeoutMs: 2000,
		})
		expect(config.toolFailureThreshold).toBe(3)
		expect(config.minConfidence).toBe(0.85)
	})

	test("partial tier overrides preserve unspecified model/provider/thinking and other tiers", () => {
		const config = configSchema.parse({
			routers: {
				codex: {
					tiers: {
						strong: { thinking: "max" },
						trivial: { provider: "local", model: "open-model" },
					},
				},
			},
		})
		expect(config.routers.codex.tiers.strong).toEqual({
			provider: "openai-codex",
			model: "gpt-6-astra",
			thinking: "max",
		})
		expect(config.routers.codex.tiers.trivial).toEqual({ provider: "local", model: "open-model", thinking: "low" })
		expect(config.routers.codex.tiers.standard).toEqual(configSchema.parse({}).routers.codex.tiers.standard)
		// Loading another agent's config must not inherit mutations from a previous merge.
		expect(configSchema.parse({}).routers.codex.tiers.strong.thinking).toBe("high")
	})

	test("custom routers can mix arbitrary providers, without hiding built-ins or rewriting the file", async () => {
		const file = tempFile()
		const contents = JSON.stringify({
			routers: { mixed },
			classifier: { timeoutMs: 5000 },
			toolFailureThreshold: 4,
			minConfidence: 0.9,
		})
		writeFileSync(file, contents)
		const config = loadConfig(file)
		expect(Object.keys(config.routers)).toEqual(["codex", "bedrock", "mixed"])
		expect(config.routers.mixed).toEqual(mixed)
		expect(config.classifier.timeoutMs).toBe(5000)
		expect(config.toolFailureThreshold).toBe(4)
		expect(config.minConfidence).toBe(0.9)
		expect(await Bun.file(file).text()).toBe(contents)
	})

	test("a custom router requires complete tiers; it does not inherit an unrelated preset", () => {
		for (const name of ["custom", "constructor", "toString"]) {
			expect(configSchema.safeParse({ routers: { [name]: { tiers: { strong: { thinking: "max" } } } } }).success).toBe(
				false,
			)
		}
		expect(() => configSchema.parse({ routers: { custom: { tiers: { trivial: mixed.tiers.trivial } } } })).toThrow(
			"standard",
		)
	})

	test("supports a Nix-style symlink without changing its target", async () => {
		const path = tempFile()
		const target = `${path}.target`
		const contents = JSON.stringify({ routers: { mixed } })
		writeFileSync(target, contents)
		symlinkSync(target, path)
		expect(loadConfig(path).routers.mixed).toEqual(mixed)
		expect(await Bun.file(target).text()).toBe(contents)
	})

	test("personal/work files have independent overrides", () => {
		const personal = tempFile()
		const work = tempFile()
		writeFileSync(personal, JSON.stringify({ routers: { codex: { tiers: { strong: { thinking: "max" } } } } }))
		writeFileSync(work, "{}")
		expect(loadConfig(personal).routers.codex.tiers.strong.thinking).toBe("max")
		expect(loadConfig(work).routers.codex.tiers.strong.thinking).toBe("high")
	})

	test("bad JSON and schema errors identify the config path", () => {
		const path = tempFile()
		writeFileSync(path, "{")
		expect(() => loadConfig(path)).toThrow(path)
		writeFileSync(path, JSON.stringify({ routers: { codex: { tiers: { strong: { typo: true } } } } }))
		expect(() => loadConfig(path)).toThrow("typo")
		expect(configSchema.safeParse({ provider: "legacy-provider", tiers: mixed.tiers }).success).toBe(false)
		expect(
			configSchema.safeParse({ routers: { custom: { tiers: { ...mixed.tiers, complex: mixed.tiers.strong } } } })
				.success,
		).toBe(false)
	})

	test.each(["bad/name", "with spaces", "", "__proto__"])("rejects ambiguous or unsafe router name %s", (name) => {
		expect(configSchema.safeParse({ routers: { [name]: mixed } }).success).toBe(false)
	})

	test.each([
		"https://hosted.example/v1",
		"file:///tmp/local",
		"http://user:pass@127.0.0.1/v1",
		"http://localhost/v1?key=secret",
		"http://localhost/v1#fragment",
	])("rejects a nonlocal or ambiguous classifier URL: %s", (baseUrl) => {
		expect(configSchema.safeParse({ classifier: { baseUrl } }).success).toBe(false)
	})

	test.each(["http://127.0.0.1:11439/v1", "http://localhost:11434/v1", "http://[::1]:11434/v1"])(
		"accepts %s",
		(baseUrl) => {
			expect(configSchema.parse({ classifier: { baseUrl } }).classifier.baseUrl).toBe(baseUrl)
		},
	)

	test.each([0, 0.5, 0.85, 1])("accepts confidence threshold %s", (minConfidence) => {
		expect(configSchema.parse({ minConfidence }).minConfidence).toBe(minConfidence)
	})

	test.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "0.85", null])(
		"rejects invalid confidence threshold %s",
		(minConfidence) => {
			expect(configSchema.safeParse({ minConfidence }).success).toBe(false)
		},
	)

	test("requires valid thinking and bounded positive timeout/threshold", () => {
		expect(configSchema.safeParse({ routers: { codex: { tiers: { trivial: { thinking: "auto" } } } } }).success).toBe(
			false,
		)
		for (const timeoutMs of [0, -1, 0.5, 120001]) {
			expect(configSchema.safeParse({ classifier: { timeoutMs } }).success).toBe(false)
		}
		for (const toolFailureThreshold of [0, -1, 0.5, 101]) {
			expect(configSchema.safeParse({ toolFailureThreshold }).success).toBe(false)
		}
	})
})

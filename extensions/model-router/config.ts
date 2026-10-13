import { readFileSync } from "node:fs"
import { z } from "zod"

export const TIERS = ["standard", "strong"] as const

export type Tier = (typeof TIERS)[number]

export const thinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])

const target = z
	.object({
		provider: z.string().trim().min(1),
		model: z.string().trim().min(1),
		thinking: thinkingSchema,
	})
	.strict()

const tiers = z.object({ standard: target, strong: target }).strict()

const router = z.object({ tiers }).strict()

// Preset names belong to router settings, not the provider catalog. Routing only knows abstract tiers.
const presets = {
	codex: {
		tiers: {
			standard: { provider: "openai-codex", model: "gpt-6.1-sol", thinking: "medium" },
			strong: { provider: "openai-codex", model: "gpt-6-astra", thinking: "high" },
		},
	},
	bedrock: {
		tiers: {
			standard: { provider: "amazon-bedrock", model: "global.anthropic.claude-sonnet-5-5", thinking: "medium" },
			strong: { provider: "amazon-bedrock", model: "global.anthropic.claude-opus-5-5", thinking: "high" },
		},
	},
}

const classifier = z
	.object({
		baseUrl: z
			.string()
			.url()
			.refine((value) => {
				const url = new URL(value)

				return (
					["http:", "https:"].includes(url.protocol) &&
					["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
					!url.username &&
					!url.password &&
					!url.search &&
					!url.hash
				)
			}, "classifier.baseUrl must be a loopback HTTP(S) URL without credentials, query, or fragment")
			.default("http://127.0.0.1:11434/v1"),
		model: z.string().trim().min(1).default("clef-flash:9b-mxfp8"),
		timeoutMs: z.number().int().min(1).max(120_000).default(10_000),
	})
	.strict()

const tierOverrides = z
	.object({
		// Read old configs without rewriting them; this retired tier is never merged or routed.
		trivial: target.partial().optional(),
		standard: target.partial().optional(),
		strong: target.partial().optional(),
	})
	.strict()

export const configSchema = z
	.object({
		routers: z
			.record(
				z
					.string()
					.regex(
						/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
						"router names must contain only letters, digits, hyphens or underscores, and start with a letter or digit",
					),
				z.object({ tiers: tierOverrides.optional() }).strict(),
			)
			.default({}),
		classifier: classifier.default({}),
		toolFailureThreshold: z.number().int().min(1).max(100).default(3),
		// Retired entropy gate: accept old files, but do not reinterpret its value as a probability.
		minConfidence: z.number().finite().min(0).max(1).optional(),
		strongProbabilityThreshold: z.number().finite().min(0).max(1).default(0.5),
	})
	.strict()
	.transform((config, ctx) => {
		const names = new Set([...Object.keys(presets), ...Object.keys(config.routers)])
		const resolved: [string, z.infer<typeof router>][] = []

		for (const name of names) {
			const defaults = Object.entries(presets).find(([presetName]) => presetName === name)?.[1]
			const overrides = Object.hasOwn(config.routers, name) ? config.routers[name] : undefined

			const merged = router.safeParse({
				tiers: Object.fromEntries(
					TIERS.map((tier) => [tier, { ...defaults?.tiers[tier], ...overrides?.tiers?.[tier] }]),
				),
			})

			if (!merged.success) {
				for (const issue of merged.error.issues) ctx.addIssue({ ...issue, path: ["routers", name, ...issue.path] })
			} else resolved.push([name, merged.data])
		}

		const { minConfidence: _retired, ...settings } = config

		return { ...settings, routers: Object.fromEntries(resolved) }
	})

export type RouterConfig = z.infer<typeof router> &
	Pick<z.infer<typeof configSchema>, "classifier" | "toolFailureThreshold" | "strongProbabilityThreshold">

export function loadConfig(path: string): z.infer<typeof configSchema> {
	let contents = "{}"

	try {
		contents = readFileSync(path, "utf8")
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			throw new Error(`model-router: cannot read ${path}`, { cause: error })
		}
	}

	try {
		return configSchema.parse(JSON.parse(contents))
	} catch (error) {
		throw new Error(`model-router: invalid ${path}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

import { z } from "zod"

const fixtureExpectationSchema = z
	.object({
		operations: z.array(z.string().min(1)),
		observationKinds: z.array(z.string().min(1)).default([]),
	})
	.strict()

export const analyzerCorpusFixtureSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("raw-shell"),
			name: z.string().min(1),
			source: z.string(),
			cwd: z.string().min(1),
			expect: fixtureExpectationSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("resolved-argv"),
			name: z.string().min(1),
			argv: z.array(z.string()).min(1),
			cwd: z.string().min(1),
			expect: fixtureExpectationSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("contextual-state"),
			name: z.string().min(1),
			argv: z.array(z.string()).min(1),
			cwd: z.string().min(1),
			files: z.record(z.string(), z.string()),
			expect: fixtureExpectationSchema,
		})
		.strict(),
])

export const policyCorpusFixtureSchema = z
	.object({
		kind: z.literal("policy"),
		name: z.string().min(1),
		effect: z.record(z.string(), z.unknown()),
		grants: z.array(z.record(z.string(), z.unknown())),
		expect: z.enum(["allow", "ask", "deny"]),
	})
	.strict()

export type AnalyzerCorpusFixture = z.infer<typeof analyzerCorpusFixtureSchema>
export type PolicyCorpusFixture = z.infer<typeof policyCorpusFixtureSchema>

import { describe, expect, test } from "bun:test"
import * as path from "node:path"
import { z } from "zod"
import { readJsonFile } from "../pi-safety/json-file"
import { analyzeResolvedCommand } from "./analyze-command"
import { analyzeShellCommand } from "./analyze-shell"
import { analyzerCorpusFixtureSchema } from "./corpus-fixture"

const corpusPath = path.join(import.meta.dir, "fixtures", "git-github.json")

describe("inert analyzer corpus", () => {
	test("checks analyzer expectations without executing fixture text", async () => {
		const parsed = readJsonFile(corpusPath, z.array(analyzerCorpusFixtureSchema))
		if (!parsed.ok) throw new Error(parsed.error.message)

		for (const fixture of parsed.value) {
			const analysis =
				fixture.kind === "raw-shell"
					? await analyzeShellCommand({ source: fixture.source, cwd: fixture.cwd })
					: analyzeResolvedCommand({ argv: fixture.argv, cwd: fixture.cwd })
			const operations: string[] = analysis.findings.map((finding) => finding.effect.operation)
			const observationKinds: string[] = analysis.observations.map((observation) => observation.kind)
			expect(operations, fixture.name).toEqual(fixture.expect.operations)
			expect(observationKinds, fixture.name).toEqual(fixture.expect.observationKinds)
		}
	})
})

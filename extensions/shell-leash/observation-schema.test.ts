import { expect, test } from "bun:test"
import type { AnalysisObservation } from "./findings"
import {
	createShellLeashObservationEnvelope,
	explainObservation,
	parseShellLeashObservationEnvelope,
	summarizeShellLeashObservations,
} from "./observation-schema"

const observations: readonly AnalysisObservation[] = [
	{ kind: "parser-failure", stage: "parse", message: "bad syntax" },
	{ kind: "recursion-limit", source: "bash -c ..." },
	{ kind: "dynamic-executable", source: "$tool", startByte: 0, endByte: 5 },
	{ kind: "dynamic-argument", source: "$remote", index: 2 },
	{ kind: "embedded-dynamic", interpreter: "python", source: "subprocess.run(command)" },
	{ kind: "unknown-git", argv: ["git", "future"] },
	{ kind: "git-scope-override", setting: "alias.publish", value: "push" },
	{ kind: "unknown-github", argv: ["gh", "future"] },
	{ kind: "github-graphql-unknown", source: "$query" },
	{ kind: "shell-syntax", issue: "missing-syntax", text: "", startByte: 2, endByte: 2 },
]

test("strict observation envelopes preserve source, time, and exhaustive explanations", () => {
	for (const observation of observations) {
		const envelope = createShellLeashObservationEnvelope({
			requestId: "request-1",
			toolCallId: "bash-1",
			createdAt: "2026-07-14T12:00:00.000Z",
			cwd: "/workspace",
			source: { kind: "static", command: "git future" },
			observation,
		})
		expect(parseShellLeashObservationEnvelope(envelope)).toEqual({ ok: true, value: envelope })
		expect(explainObservation(observation).length).toBeGreaterThan(0)
	}
})

test("observation summaries count kinds and show a bounded recent explanation", () => {
	const entries = observations.slice(0, 6).map((observation, index) =>
		createShellLeashObservationEnvelope({
			requestId: "request-1",
			toolCallId: `bash-${index}`,
			createdAt: `2026-07-14T12:00:0${index}.000Z`,
			cwd: "/workspace",
			source: { kind: "static", command: "example" },
			observation,
		}),
	)
	const summary = summarizeShellLeashObservations(entries)
	expect(summary).toContain("shell-leash: 6 hidden observation(s)")
	expect(summary).toContain("dynamic-argument: 1")
	expect(summary.match(/^2026-/gm)).toHaveLength(5)
})

test("observation envelope parsing rejects forged fields and unknown variants", () => {
	const base = createShellLeashObservationEnvelope({
		requestId: "request-1",
		toolCallId: "bash-1",
		cwd: "/workspace",
		source: { kind: "runtime", argv: ["git", "future"] },
		observation: { kind: "unknown-git", argv: ["git", "future"] },
	})
	expect(parseShellLeashObservationEnvelope({ ...base, forged: true }).ok).toBe(false)
	expect(parseShellLeashObservationEnvelope({ ...base, observation: { kind: "invented" } }).ok).toBe(false)
})

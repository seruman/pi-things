import { InMemoryCredentialStore } from "@earendil-works/pi-ai"
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent"
import { type RoutingInput, classifyTier } from "./classifier"
import { type Tier, configSchema } from "./config"

// Synthetic, hand-labelled scenarios exercise routing behaviours without using
// private transcripts. This is a regression corpus, not a benchmark of task success.
export const routingCases: { id: string; expected: Tier; expectedNewTask?: boolean; input: RoutingInput }[] = [
	{
		id: "simple-command",
		expected: "standard",
		input: { prompt: "What command prints the current working directory?", hasImages: false },
	},
	{
		id: "ordinary-explanation",
		expected: "standard",
		input: { prompt: "Explain the difference between git fetch and git pull in plain language.", hasImages: false },
	},
	{
		id: "wording-only",
		expected: "standard",
		expectedNewTask: false,
		input: {
			prompt: "Shorten the tooltip to one sentence and use sentence case. Keep the keyboard shortcut unchanged.",
			hasImages: false,
			currentTier: "standard",
			task: "Polish the toolbar tooltips in a drawing application",
		},
	},
	{
		id: "routine-code-edit",
		expected: "standard",
		input: {
			prompt: "Add a --json flag to this CLI so it prints the existing result object as JSON.",
			hasImages: false,
		},
	},
	{
		id: "new-routine-task-after-hard-work",
		expected: "standard",
		expectedNewTask: true,
		input: {
			prompt: "Unrelated new task: fix the typo 'recieve' to 'receive' in README.md.",
			hasImages: false,
			currentTier: "strong",
			task: "Investigate self-intersections in a polygon triangulation algorithm",
			recentConversation: "assistant:\nThe geometry bug is fixed and the regression tests pass.",
		},
	},
	{
		id: "algorithm-explanation",
		expected: "strong",
		expectedNewTask: false,
		input: {
			prompt: "Derive why the pruning rule is sound. Could a cheaper path be discarded when edge weights change?",
			hasImages: false,
			currentTier: "standard",
			task: "Review the correctness of an incremental pathfinding algorithm",
			recentConversation:
				"assistant:\nThe proposed search prunes nodes using an earlier distance estimate. I have not proved that estimate remains a valid bound after an edge changes.",
		},
	},
	{
		id: "simple-wording-hard-question",
		expected: "strong",
		expectedNewTask: false,
		input: {
			prompt:
				"Why does that tiny rounding error make the shape disappear? Give me a simple explanation after tracing the cause.",
			hasImages: false,
			currentTier: "standard",
			task: "Diagnose disappearing polygons in a vector drawing application's clipping algorithm",
			recentConversation:
				"assistant:\nNearly collinear edges may flip the orientation predicate. We still need to trace how that decision affects the clipping graph.",
		},
	},
	{
		id: "repeated-substantive-correction",
		expected: "strong",
		expectedNewTask: false,
		input: {
			prompt:
				"The second counterexample still breaks your proof. Reassess the invariant instead of repeating the conclusion.",
			hasImages: false,
			currentTier: "standard",
			task: "Prove that a graph-colouring heuristic always satisfies a scheduling constraint",
			recentConversation:
				"user:\nA triangle disproves the first argument.\n\nassistant:\nAcyclic input should make the greedy ordering sufficient.\n\nuser:\nThis tree also fails when the vertices arrive in a different order.",
		},
	},
	{
		id: "short-command-in-investigation",
		expected: "strong",
		expectedNewTask: false,
		input: {
			prompt: "Try the randomized geometry check you proposed.",
			hasImages: false,
			currentTier: "strong",
			task: "Isolate a numerical instability in a collision-detection algorithm and establish the minimal counterexample",
			recentConversation:
				"assistant:\nI will generate nearly tangent shapes, compare the fast predicate with an exact reference, and minimize any disagreement before identifying the faulty calculation.",
		},
	},
	{
		id: "approval-of-hard-work",
		expected: "strong",
		expectedNewTask: false,
		input: {
			prompt: "Yes, go ahead.",
			hasImages: false,
			currentTier: "strong",
			task: "Investigate an unsound simplification in a symbolic algebra engine",
			recentConversation:
				"assistant:\nI'll trace the rewrite rules, construct counterexamples around branch cuts, and determine which domain assumptions make the simplification valid.",
		},
	},
	{
		id: "cross-cutting-consequences",
		expected: "strong",
		input: {
			prompt:
				"Assess replacing the text editor's code-point indexing with grapheme-cluster indexing. Trace consequences for cursor movement, selections, undo and collaborative edits; don't implement it yet.",
			hasImages: false,
		},
	},
	{
		id: "hard-task-after-easy-smoke",
		expected: "strong",
		expectedNewTask: true,
		input: {
			prompt:
				"Design a distributed payment ledger that preserves correctness across retries, out-of-order events, and partial failures. Explain consistency tradeoffs.",
			hasImages: false,
			currentTier: "standard",
			task: "What command prints the current working directory?",
			recentConversation:
				"user:\nWhat command prints the current working directory?\n\nassistant:\nrouter-smoke:middle:medium",
		},
	},
	{
		id: "hard-task-after-easy-dialogue",
		expected: "strong",
		expectedNewTask: true,
		input: {
			prompt:
				"Design a distributed payment ledger that preserves correctness across retries, out-of-order events, and partial failures. Explain consistency tradeoffs.",
			hasImages: false,
			currentTier: "standard",
			task: "What command prints the current working directory?",
			recentConversation:
				"user:\nWhat command prints the current working directory?\n\nassistant:\nUse pwd to print the current working directory.",
		},
	},
	{
		id: "approval-without-recent-transcript",
		expected: "strong",
		expectedNewTask: false,
		input: {
			prompt: "Yes, do that.",
			hasImages: false,
			currentTier: "strong",
			task: "Prove whether a constraint solver's symmetry-breaking rule preserves every valid class of solutions",
		},
	},
	{
		id: "frustrated-routine-request",
		expected: "standard",
		input: {
			prompt: "Stop overcomplicating it! I only need the command to show the current Git branch.",
			hasImages: false,
		},
	},
	{
		id: "generic-sql-explanation",
		expected: "standard",
		input: {
			prompt: "Explain the difference between INNER JOIN and LEFT JOIN with a small example.",
			hasImages: false,
		},
	},
	{
		id: "operational-question-no-code",
		expected: "strong",
		input: {
			prompt:
				"Why did our payment retries double-charge customers despite idempotency keys? Investigate the cause; no code changes.",
			hasImages: false,
		},
	},
	{
		id: "subtle-review-short-output",
		expected: "strong",
		input: {
			prompt:
				"Review this distributed locking design for races during lease expiry and network partitions. Keep your answer short.",
			hasImages: false,
		},
	},
	{
		id: "routine-rename-after-investigation",
		expected: "standard",
		expectedNewTask: true,
		input: {
			prompt: "That investigation is finished. New task: rename the README heading from Installation to Setup.",
			hasImages: false,
			currentTier: "strong",
			task: "Trace duplicate payments through distributed retries",
			recentConversation: "assistant:\nThe cause was verified and the investigation is complete.",
		},
	},
	{
		id: "substantive-correction-not-copyediting",
		expected: "strong",
		expectedNewTask: false,
		input: {
			prompt:
				"That measures a different property. Audit the algorithm and determine whether it can actually preserve angles.",
			hasImages: false,
			currentTier: "standard",
			task: "Review the mathematical guarantees of a mesh parameterization algorithm",
			recentConversation:
				"assistant:\nThe transform is conformal because it preserves each triangle's area.\n\nuser:\nArea preservation does not establish angle preservation.",
		},
	},
	{
		id: "architecture",
		expected: "strong",
		input: {
			prompt:
				"Design a distributed payment ledger that stays correct across retries, out-of-order events and partial failures. Explain the consistency tradeoffs.",
			hasImages: false,
		},
	},
]

// Opt-in, local classifier only. No real session input, downstream generation,
// server startup, downloads, or configuration writes.
if (import.meta.main) {
	const repeats = Number(process.env.ROUTER_EVAL_REPEATS ?? 1)

	if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error("ROUTER_EVAL_REPEATS must be 1..20")

	const { classifier } = configSchema.parse({
		classifier: {
			baseUrl: process.env.ROUTER_EVAL_BASE_URL ?? "http://127.0.0.1:11434/v1",
			model: process.env.ROUTER_EVAL_MODEL ?? "clef-flash:9b-mxfp8",
		},
	})

	const registry = new ModelRegistry(
		await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		}),
	)

	const prewarm = await classifyTier(
		{ ...classifier, timeoutMs: 30_000 },
		{ prompt: "Prewarm the local classifier", hasImages: false },
		registry,
	)

	if (prewarm.kind !== "classified") throw new Error(`Local classifier unavailable: ${JSON.stringify(prewarm)}`)
	let passed = 0
	let underRouted = 0
	let overRouted = 0
	let unavailable = 0
	let continuityErrors = 0

	for (let run = 1; run <= repeats; run++) {
		for (const { id, expected, expectedNewTask, input } of routingCases) {
			const result = await classifyTier(classifier, input, registry)
			const actual = result.kind === "classified" ? result.tier : null

			const taskMatch =
				expectedNewTask === undefined || (result.kind === "classified" && result.newTask === expectedNewTask)

			const match = actual === expected && taskMatch

			if (match) passed++

			if (actual === null) unavailable++
			else {
				if (!taskMatch) continuityErrors++

				if (actual !== expected) {
					if (expected === "strong") underRouted++
					else overRouted++
				}
			}

			console.log(JSON.stringify({ run, id, expected, expectedNewTask, actual, match, result }))
		}
	}

	const total = routingCases.length * repeats
	console.log(JSON.stringify({ classifier, passed, total, underRouted, overRouted, unavailable, continuityErrors }))

	if (passed !== total) process.exitCode = 1
}

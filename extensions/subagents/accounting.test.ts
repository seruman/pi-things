import { afterEach, beforeEach, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolResultMessage, Usage } from "@earendil-works/pi-ai"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { z } from "zod"
import {
	ATTRIBUTION_ENTRY,
	CHARGE_ENTRY,
	CHECKPOINT_ENTRY,
	SOURCE_ENTRY,
	UsageAccounting,
	attributionSchema,
	chargeSchema,
	checkpointSchema,
	sourceSchema,
} from "./accounting"
import type { ParentContext } from "./contracts"
import { type RunMetadata, prepareRun, runDirectory, updateMetadata, writeMetadata } from "./runs"
import { sumUsage } from "./usage"

let root: string

let savedDir: string | undefined

let parent: SessionManager

let ctx: ParentContext

let accounting: UsageAccounting

function failUI(): never {
	throw new Error("Unexpected UI")
}

function install(): void {
	ctx = {
		cwd: root,
		hasUI: false,
		mode: "print",
		sessionManager: parent,
		ui: { theme: { fg: failUI }, notify: failUI, setWidget: failUI, custom: failUI },
	}
	accounting = new UsageAccounting({
		appendEntry: (type, data) => {
			parent.appendCustomEntry(type, data)
		},
	})
}

beforeEach(() => {
	savedDir = process.env.PI_CODING_AGENT_DIR
	root = mkdtempSync(join(tmpdir(), "subagent-accounting-"))
	process.env.PI_CODING_AGENT_DIR = root
	parent = SessionManager.create(root, root, { id: "parent" })
	parent.appendMessage({ role: "user", content: "task", timestamp: Date.now() })
	install()
})

afterEach(() => {
	if (savedDir === undefined) Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR")
	else process.env.PI_CODING_AGENT_DIR = savedDir
	rmSync(root, { recursive: true, force: true })
})

function usage(tokens: number): Usage {
	return {
		input: tokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: tokens,
		cost: { input: tokens / 100, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens / 100 },
	}
}

function child(legacy = false) {
	const prepared = prepareRun()

	const metadata: RunMetadata = {
		...prepared,
		version: 1,
		parentSessionId: "parent",
		blockId: "block",
		cwd: root,
		provider: "launch-provider",
		model: "launch-model",
		thinking: "off",
		launchArgs: [],
		createdAt: new Date().toISOString(),
	}

	if (!legacy) metadata.accountingVersion = 1
	writeMetadata(metadata)
	const session = SessionManager.open(prepared.sessionFile, root, root)
	session.appendMessage({ role: "user", content: "child task", timestamp: Date.now() })

	return { ...prepared, session }
}

function reply(session: SessionManager, tokens = 5, provider = "actual-provider", model = "actual-model") {
	return session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "ANSWER" }],
		stopReason: "stop",
		api: "openai-responses",
		provider,
		model,
		timestamp: Date.now(),
		usage: usage(tokens),
	})
}

function records() {
	return parent
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === SOURCE_ENTRY ? [sourceSchema.parse(entry.data)] : [],
		)
}

function checkpoints() {
	return parent
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY ? [checkpointSchema.parse(entry.data)] : [],
		)
}

function attributions() {
	return parent
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === ATTRIBUTION_ENTRY ? [attributionSchema.parse(entry.data)] : [],
		)
}

function receipt(id: string, cost?: Usage) {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: id,
		toolName: "codemode",
		content: [{ type: "text", text: "answers only" }],
		isError: false,
		timestamp: Date.now(),
	}

	if (cost) message.usage = cost

	return parent.appendMessage(message)
}

function reload() {
	parent = SessionManager.open(z.string().parse(parent.getSessionFile()), root, root)
	install()
}

test("parallel observations preserve source identity and actual model attribution independently of printed answers", () => {
	const a = child()
	const b = child()
	reply(a.session, 5, "provider-a", "model-a")
	reply(b.session, 7, "provider-b", "model-b")
	accounting.reconcile(ctx, "wait")
	const first = accounting.charge(ctx, "parallel-a")
	const second = accounting.charge(ctx, "parallel-b")
	expect(sumUsage([first, second]).totalTokens).toBe(12)
	expect(records()).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				handle: a.handle,
				childSessionId: a.session.getSessionId(),
				provider: "provider-a",
				model: "model-a",
				usage: usage(5),
			}),
			expect.objectContaining({
				handle: b.handle,
				childSessionId: b.session.getSessionId(),
				provider: "provider-b",
				model: "model-b",
				usage: usage(7),
			}),
		]),
	)
	expect(records()).toHaveLength(2)
	expect(checkpoints().every((checkpoint) => checkpoint.complete)).toBe(true)
})

test("receipted usage survives reload and parent branching; follow-ups charge only new source entries", () => {
	const c = child()
	reply(c.session)
	accounting.reconcile(ctx, "wait")
	receipt("first", accounting.charge(ctx, "first"))
	const branch = parent.getEntries()[0].id
	reload()
	parent.branch(branch)
	accounting.reconcile(ctx, "reload")
	expect(accounting.charge(ctx, "repeated")).toBeUndefined()
	reply(c.session, 7, "changed-provider", "changed-model")
	accounting.reconcile(ctx, "follow-up")
	expect(accounting.charge(ctx, "follow-up")).toEqual(usage(7))
	expect(records()).toHaveLength(2)
})

test("an unacknowledged reservation is retried after reload, without duplicating source facts", () => {
	const c = child()
	reply(c.session)
	accounting.reconcile(ctx, "wait")
	expect(accounting.charge(ctx, "crashed-before-result")).toEqual(usage(5))
	reload()
	accounting.reconcile(ctx, "reload")
	expect(accounting.charge(ctx, "retry")).toEqual(usage(5))
	expect(records()).toHaveLength(1)
	receipt("retry", usage(5))
	reload()
	expect(accounting.charge(ctx, "again")).toBeUndefined()
})

test("nested charges share the actual enclosing receipt, even when its provider-issued id contains slashes", () => {
	parent.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "provider/id", name: "codemode", arguments: {} }],
		stopReason: "toolUse",
		api: "openai-responses",
		provider: "parent",
		model: "parent",
		timestamp: Date.now(),
		usage: usage(0),
	})
	const c = child()
	reply(c.session)
	accounting.reconcile(ctx, "wait")
	expect(accounting.charge(ctx, "provider/id/0")).toEqual(usage(5))
	expect(accounting.charge(ctx, "provider/id/1")).toBeUndefined()

	const charges = parent
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === CHARGE_ENTRY ? [chargeSchema.parse(entry.data)] : [],
		)

	expect(charges[0].parentToolCallId).toBe("provider/id")
	receipt("provider/id", usage(5))
	reload()
	expect(accounting.charge(ctx, "next")).toBeUndefined()
})

test("a completed tool result without usage releases its reservation for retry", () => {
	const c = child()
	reply(c.session)
	accounting.reconcile(ctx, "wait")
	accounting.charge(ctx, "failed-delivery")
	receipt("failed-delivery")
	expect(accounting.charge(ctx, "retry")).toEqual(usage(5))
})

test("settlement releases lost in-flight results for retry without a runtime reload", () => {
	const c = child()
	reply(c.session)
	accounting.reconcile(ctx, "wait")
	accounting.charge(ctx, "lost")
	expect(accounting.charge(ctx, "parallel")).toBeUndefined()
	accounting.releaseReservations(ctx)
	expect(accounting.charge(ctx, "retry")).toEqual(usage(5))
})

test("an older result with a reused tool-call ID does not acknowledge a later charge", () => {
	const c = child()
	reply(c.session)
	accounting.reconcile(ctx, "wait")
	receipt("reused", accounting.charge(ctx, "reused"))
	reply(c.session, 7)
	accounting.reconcile(ctx, "wait")
	expect(accounting.charge(ctx, "reused")).toEqual(usage(7))
	reload()
	expect(accounting.charge(ctx, "retry-after-crash")).toEqual(usage(7))
})

test("background sources and reservations are not confirmed native attribution", () => {
	const c = child()
	reply(c.session)
	accounting.reconcile(ctx, "poll")
	expect(records()).toHaveLength(1)
	expect(attributions()).toEqual([])
	expect(accounting.charge(ctx, "lost")).toEqual(usage(5))
	accounting.reconcile(ctx, "poll")
	expect(attributions()).toEqual([])
	receipt("lost")
	accounting.reconcile(ctx, "settled")
	expect(attributions()).toEqual([])

	const resultId = receipt("retry", accounting.charge(ctx, "retry"))
	accounting.reconcile(ctx, "settled")
	expect(attributions()).toEqual([
		expect.objectContaining({
			accounting: "attribution-only",
			toolCallId: "retry",
			toolResultEntryId: resultId,
			sourceKeys: [records()[0].sourceKey],
		}),
	])
	expect(attributions()[0]).not.toHaveProperty("usage")
	expect(attributions()[0]).not.toHaveProperty("cost")
})

test("attribution links one native result to multiple reservations and the actual source models", () => {
	parent.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "provider/batch", name: "codemode", arguments: {} }],
		stopReason: "toolUse",
		api: "openai-responses",
		provider: "parent",
		model: "parent",
		timestamp: Date.now(),
		usage: usage(0),
	})
	const c = child()
	reply(c.session, 5, "provider-a", "model-a")
	accounting.reconcile(ctx, "wait")
	const first = accounting.charge(ctx, "provider/batch/1")
	reply(c.session, 7, "provider-b", "model-b")
	accounting.reconcile(ctx, "wait")
	const second = accounting.charge(ctx, "provider/batch/2")
	const resultId = receipt("provider/batch", sumUsage([first, second, usage(3)]))
	accounting.reconcile(ctx, "settled")

	const [attribution] = attributions()
	expect(attributions()).toHaveLength(1)
	expect(attribution).toMatchObject({
		toolCallId: "provider/batch",
		toolResultEntryId: resultId,
		sourceKeys: records().map((source) => source.sourceKey),
	})
	expect(attribution.chargeIds).toHaveLength(2)
	const attributed = records().filter((source) => attribution.sourceKeys.includes(source.sourceKey))
	expect(attributed.map((source) => [source.provider, source.model, source.usage.cost.total])).toEqual([
		["provider-a", "model-a", 0.05],
		["provider-b", "model-b", 0.07],
	])
	// Attribution describes only the subagent portion; the unrelated 3 tokens remain native.
	expect(sumUsage(attributed.map((source) => source.usage)).totalTokens).toBe(12)
	expect(accounting.charge(ctx, "again")).toBeUndefined()
})

test("attribution is recovered after a crash following the native receipt and is stable across reload and branching", () => {
	const c = child()
	reply(c.session)
	accounting.reconcile(ctx, "wait")
	const resultId = receipt("first", accounting.charge(ctx, "first"))
	expect(attributions()).toEqual([])
	reload()
	parent.branch(parent.getEntries()[0].id)
	accounting.reconcile(ctx, "start")
	const linked = attributions()
	expect(linked).toHaveLength(1)
	expect(linked[0].toolResultEntryId).toBe(resultId)
	expect(accounting.charge(ctx, "again")).toBeUndefined()
	reload()
	accounting.reconcile(ctx, "start")
	const count = parent.getEntries().length
	accounting.reconcile(ctx, "poll")
	expect(attributions()).toEqual(linked)
	expect(parent.getEntries()).toHaveLength(count)
})

test("reused native tool-call IDs get distinct attribution by result entry ID", () => {
	const c = child()
	reply(c.session)
	accounting.reconcile(ctx, "wait")
	const firstId = receipt("reused", accounting.charge(ctx, "reused"))
	reply(c.session, 7)
	accounting.reconcile(ctx, "wait")
	const secondId = receipt("reused", accounting.charge(ctx, "reused"))
	accounting.reconcile(ctx, "settled")
	expect(attributions().map((entry) => entry.toolCallId)).toEqual(["reused", "reused"])
	expect(attributions().map((entry) => entry.toolResultEntryId)).toEqual([firstId, secondId])
	expect(attributions().map((entry) => entry.sourceKeys)).toEqual(records().map((source) => [source.sourceKey]))
})

test.each([
	{ name: undefined, stoppedAt: undefined },
	{ name: "reviewer", stoppedAt: undefined },
	{ name: undefined, stoppedAt: "2026-10-16T21:30:36.428Z" },
	{ name: "reviewer", stoppedAt: "2026-10-16T21:30:36.428Z" },
])("unchanged observations do not append duplicate facts or checkpoint noise: %j", (metadata) => {
	const c = child()
	updateMetadata(runDirectory(c.handle), metadata)
	reply(c.session)
	accounting.reconcile(ctx, "wait")
	const count = parent.getEntries().length

	for (let poll = 0; poll < 100; poll++) accounting.reconcile(ctx, "poll")
	accounting.reconcile(ctx, "shutdown")
	expect(parent.getEntries()).toHaveLength(count)
	expect(checkpoints()).toHaveLength(1)

	reload()
	accounting.reconcile(ctx, "start")
	accounting.reconcile(ctx, "poll")
	expect(parent.getEntries()).toHaveLength(count)
	expect(checkpoints()).toHaveLength(1)
})

test("named child checkpoint changes are persisted once for renames, new usage, and stopping", () => {
	const c = child()
	updateMetadata(runDirectory(c.handle), { name: "reviewer" })
	reply(c.session)
	accounting.reconcile(ctx, "wait")
	expect(checkpoints()).toHaveLength(1)

	updateMetadata(runDirectory(c.handle), { name: "renamed reviewer" })
	accounting.reconcile(ctx, "rename")
	accounting.reconcile(ctx, "poll")
	expect(checkpoints()).toHaveLength(2)
	expect(checkpoints().at(-1)?.name).toBe("renamed reviewer")

	reply(c.session, 7)
	accounting.reconcile(ctx, "poll")
	accounting.reconcile(ctx, "poll")
	expect(checkpoints()).toHaveLength(3)
	expect(checkpoints().at(-1)?.sourceCount).toBe(2)
	expect(records()).toHaveLength(2)

	const stoppedAt = "2026-10-16T21:30:36.428Z"
	updateMetadata(runDirectory(c.handle), { stoppedAt })
	accounting.reconcile(ctx, "stop")
	accounting.reconcile(ctx, "poll")
	expect(checkpoints()).toHaveLength(4)
	expect(checkpoints().at(-1)?.stoppedAt).toBe(stoppedAt)

	const count = parent.getEntries().length
	reload()
	accounting.reconcile(ctx, "start")
	accounting.reconcile(ctx, "poll")
	expect(parent.getEntries()).toHaveLength(count)
	expect(accounting.charge(ctx, "deliver")).toEqual(sumUsage([usage(5), usage(7)]))
})

test("all child branches count, cache warming is attributed, and tool/summary costs remain explicitly unattributed", () => {
	const c = child()
	const active = reply(c.session)
	reply(c.session, 7, "other", "other-model")
	c.session.branch(active)
	c.session.appendCustomEntry("branch-selected")
	c.session.appendUsage("cache_warm", "cache-provider", "cache-model", usage(2))
	c.session.appendCompaction("summary", null, 10, undefined, false, usage(3))
	c.session.branchWithSummary(active, "branch summary", undefined, false, usage(4))
	c.session.appendMessage({
		role: "toolResult",
		toolCallId: "nested",
		toolName: "nested-model",
		content: [],
		isError: false,
		timestamp: Date.now(),
		usage: usage(6),
	})
	accounting.reconcile(ctx, "stop")
	expect(accounting.charge(ctx, "stop")).toEqual(usage(27))
	expect(
		records()
			.filter((source) => source.provider === null)
			.map((source) => source.kind)
			.sort(),
	).toEqual(["branch_summary", "compaction", "toolResult"])
	expect(records()).toContainEqual(
		expect.objectContaining({ kind: "usage:cache_warm", provider: "cache-provider", model: "cache-model" }),
	)
})

test("session switches preserve all known paths and source IDs deduplicate the same file seen twice", () => {
	const c = child()
	reply(c.session)
	const second = SessionManager.create(root, root)
	second.appendMessage({ role: "user", content: "next", timestamp: Date.now() })
	reply(second, 7)
	const path = z.string().parse(second.getSessionFile())
	updateMetadata(runDirectory(c.handle), { sessionFile: path, sessionFiles: [c.sessionFile, path, path] })
	accounting.reconcile(ctx, "stop")
	const charged = accounting.charge(ctx, "stop")
	expect(charged?.totalTokens).toBe(12)
	expect(charged?.cost.total).toBeCloseTo(0.12)
	expect(records()).toHaveLength(2)
	expect(checkpoints().at(-1)?.files).toHaveLength(2)
})

test("partial JSONL preserves its valid prefix, marks incomplete, and recovers without duplicate charges", () => {
	const c = child()
	reply(c.session)
	const saved = readFileSync(c.sessionFile, "utf8")
	appendFileSync(c.sessionFile, '{"type":')
	accounting.reconcile(ctx, "poll")
	expect(records()).toHaveLength(1)
	expect(checkpoints().at(-1)?.complete).toBe(false)
	receipt("prefix", accounting.charge(ctx, "prefix"))
	writeFileSync(c.sessionFile, saved)
	reply(c.session, 7)
	accounting.reconcile(ctx, "poll")
	expect(checkpoints().at(-1)?.complete).toBe(true)
	expect(accounting.charge(ctx, "rest")).toEqual(usage(7))
})

test("missing transcripts preserve known facts and expose incomplete coverage without creating files", () => {
	const c = child()
	reply(c.session)
	accounting.reconcile(ctx, "wait")
	rmSync(c.sessionFile)
	accounting.reconcile(ctx, "stop")
	expect(records()).toHaveLength(1)
	expect(checkpoints().at(-1)).toMatchObject({
		complete: false,
		files: [expect.objectContaining({ error: expect.any(String) })],
	})
	expect(() => readFileSync(c.sessionFile)).toThrow()
})

test("legacy runs are visible in the ledger but not blindly recharged into native totals", () => {
	const c = child(true)
	reply(c.session)
	accounting.reconcile(ctx, "start")
	expect(records()).toEqual([expect.objectContaining({ billing: "legacy", usage: usage(5) })])
	expect(checkpoints().at(-1)?.legacy).toBe(true)
	expect(accounting.charge(ctx, "list")).toBeUndefined()
})

test("accounting preserves optional token fields and isolates foreign-parent runs", () => {
	const c = child()
	const part = { ...usage(5), reasoning: 2, cacheWrite1h: 3 }
	c.session.appendUsage("custom", "provider", "model", part)
	const foreign = child()
	reply(foreign.session, 100)
	updateMetadata(runDirectory(foreign.handle), { parentSessionId: "other-parent" })
	accounting.reconcile(ctx, "wait")
	expect(accounting.charge(ctx, "list")).toEqual(part)
	expect(records()).toHaveLength(1)
})

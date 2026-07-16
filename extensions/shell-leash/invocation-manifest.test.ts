import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import * as path from "node:path"
import { withTestTempDirectoryAsync } from "../pi-safety/test-temp-directory"
import { analyzeResolvedCommand } from "./analyze-command"
import { createInvocationPermit, createRequestLease } from "./grants"
import {
	type InvocationManifest,
	parseInvocationManifest,
	readInvocationManifest,
	writeInvocationManifest,
} from "./invocation-manifest"

const MANIFEST_LIFETIME = {
	createdAt: "2026-07-14T12:00:00.000Z",
	expiresAt: "2099-07-14T12:00:00.000Z",
} as const

describe("parseInvocationManifest", () => {
	test("accepts a structural manifest containing invocation permits and request leases", () => {
		const effect = analyzeResolvedCommand({ argv: ["git", "push", "origin", "main"], cwd: "/workspace" }).findings[0]
			?.effect
		expect(effect).toBeDefined()
		if (!effect) return
		const permit = createInvocationPermit("bash-1", [effect])
		const input: InvocationManifest = {
			version: 1,
			...MANIFEST_LIFETIME,
			requestId: "request-1",
			toolCallId: "bash-1",
			realExecutables: { git: "/guarded-fixture/bin/git" },
			observationLog: "/guarded-fixture/events.jsonl",
			permit: { ...permit, effects: [...permit.effects] },
			leases: [createRequestLease("request-1", "git.push", { kind: "any" })],
		}

		expect(parseInvocationManifest(input)).toEqual({ ok: true, value: input })
	})

	test("rejects an unknown effect variant instead of treating it as a grant", () => {
		const result = parseInvocationManifest({
			version: 1,
			...MANIFEST_LIFETIME,
			requestId: "request-1",
			toolCallId: "bash-1",
			realExecutables: { git: "/guarded-fixture/bin/git" },
			observationLog: "/guarded-fixture/events.jsonl",
			permit: { toolCallId: "bash-1", effects: [{ kind: "future-effect", operation: "allow.everything" }] },
			leases: [],
		})

		expect(result.ok).toBe(false)
	})

	test("rejects expired or cross-invocation grant metadata", () => {
		const base = {
			version: 1,
			...MANIFEST_LIFETIME,
			requestId: "request-1",
			toolCallId: "bash-1",
			realExecutables: { git: "/guarded-fixture/bin/git" },
			observationLog: "/guarded-fixture/events.jsonl",
			permit: createInvocationPermit("bash-1", []),
			leases: [],
		} as const
		expect(parseInvocationManifest(base, { now: new Date("2100-01-01T00:00:00.000Z") }).ok).toBe(false)
		expect(parseInvocationManifest({ ...base, permit: createInvocationPermit("bash-other", []) }).ok).toBe(false)
		expect(
			parseInvocationManifest({
				...base,
				leases: [createRequestLease("request-other", "git.push", { kind: "any" })],
			}).ok,
		).toBe(false)
		expect(parseInvocationManifest({ ...base, expiresAt: base.createdAt }).ok).toBe(false)
	})

	test("writes a new private manifest that round-trips through strict parsing", async () => {
		await withTestTempDirectoryAsync("shell-leash-manifest-write-", async (root) => {
			const manifestPath = path.join(root, "manifest.json")
			const permit = createInvocationPermit("bash-1", [])
			const manifest: InvocationManifest = {
				version: 1,
				...MANIFEST_LIFETIME,
				requestId: "request-1",
				toolCallId: "bash-1",
				realExecutables: { git: path.join(root, "git") },
				observationLog: path.join(root, "events.jsonl"),
				permit,
				leases: [],
			}
			expect(await writeInvocationManifest(manifestPath, manifest)).toEqual({ ok: true, value: undefined })
			expect(await readInvocationManifest(manifestPath)).toEqual({ ok: true, value: manifest })
		})
	})

	test("adapts invalid JSON into a Result at the file boundary", async () => {
		await withTestTempDirectoryAsync("shell-leash-manifest-", async (root) => {
			const manifestPath = path.join(root, "manifest.json")
			await writeFile(manifestPath, "{not-json", { mode: 0o600 })
			const result = await readInvocationManifest(manifestPath)
			expect(result.ok).toBe(false)
			if (!result.ok) expect(result.error.kind).toBe("invalid-json")
		})
	})
})

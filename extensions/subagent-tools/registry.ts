import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SubagentEntry, SubagentStatus } from "./types"

const OUTPUT_BUFFER_MAX = 100 * 1024 // 100KB per stream

function outputDir(sessionId?: string): string {
	const id = sessionId || process.pid.toString()
	return join(tmpdir(), "pi-subagents", id)
}

export class SubagentRegistry {
	private entries = new Map<string, SubagentEntry>()
	private sessionId?: string

	setSessionId(id: string): void {
		this.sessionId = id
	}

	add(entry: SubagentEntry): void {
		this.entries.set(entry.agentId, entry)
		// Create output files on disk
		this.ensureOutputDir()
		writeFileSync(this.outputFilePath(entry.agentId), "", "utf-8")
		writeFileSync(this.errorFilePath(entry.agentId), "", "utf-8")
	}

	get(agentId: string): SubagentEntry | undefined {
		return this.entries.get(agentId)
	}

	all(): SubagentEntry[] {
		return [...this.entries.values()]
	}

	running(): SubagentEntry[] {
		return this.all().filter((e) => e.status === "running")
	}

	runningCount(): number {
		return this.running().length
	}

	updateStatus(agentId: string, status: SubagentStatus, exitCode?: number): void {
		const entry = this.entries.get(agentId)
		if (!entry) return
		entry.status = status
		if (exitCode !== undefined) entry.exitCode = exitCode
		if (status !== "running") entry.endedAt = Date.now()
		if (entry.timeoutTimer) {
			clearTimeout(entry.timeoutTimer)
			entry.timeoutTimer = undefined
		}
	}

	appendStdout(agentId: string, data: string): void {
		const entry = this.entries.get(agentId)
		if (!entry) return
		entry.stdout += data
		if (entry.stdout.length > OUTPUT_BUFFER_MAX) {
			entry.stdout = entry.stdout.slice(-OUTPUT_BUFFER_MAX)
		}
		// Also write to disk
		try {
			appendFileSync(this.outputFilePath(agentId), data, "utf-8")
		} catch {
			// best-effort
		}
	}

	appendStderr(agentId: string, data: string): void {
		const entry = this.entries.get(agentId)
		if (!entry) return
		entry.stderr += data
		if (entry.stderr.length > OUTPUT_BUFFER_MAX) {
			entry.stderr = entry.stderr.slice(-OUTPUT_BUFFER_MAX)
		}
		try {
			appendFileSync(this.errorFilePath(agentId), data, "utf-8")
		} catch {
			// best-effort
		}
	}

	getDuration(entry: SubagentEntry): number {
		const end = entry.endedAt ?? Date.now()
		return end - entry.startedAt
	}

	/** Read output from disk file (survives memory pressure) */
	readOutputFile(agentId: string): string {
		try {
			return readFileSync(this.outputFilePath(agentId), "utf-8")
		} catch {
			// Fall back to in-memory
			return this.entries.get(agentId)?.stdout ?? ""
		}
	}

	/** Read stderr from disk file */
	readErrorFile(agentId: string): string {
		try {
			return readFileSync(this.errorFilePath(agentId), "utf-8")
		} catch {
			return this.entries.get(agentId)?.stderr ?? ""
		}
	}

	/** Get the output file path for an agent (for read tool) */
	outputFilePath(agentId: string): string {
		return join(outputDir(this.sessionId), `${agentId}.output`)
	}

	/** Get the error file path for an agent */
	errorFilePath(agentId: string): string {
		return join(outputDir(this.sessionId), `${agentId}.stderr`)
	}

	/** Evict a completed agent from the registry (keeps files on disk) */
	evict(agentId: string): boolean {
		const entry = this.entries.get(agentId)
		if (!entry || entry.status === "running") return false
		this.entries.delete(agentId)
		return true
	}

	/** Evict all non-running agents */
	evictCompleted(): number {
		let count = 0
		for (const entry of this.all()) {
			if (entry.status !== "running") {
				this.entries.delete(entry.agentId)
				count++
			}
		}
		return count
	}

	/** Clean up output directory */
	cleanupFiles(): void {
		try {
			const dir = outputDir(this.sessionId)
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
		} catch {
			// best-effort
		}
	}

	private ensureOutputDir(): void {
		const dir = outputDir(this.sessionId)
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
	}
}

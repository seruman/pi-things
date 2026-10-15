import { randomUUID } from "node:crypto"
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type RunMetadata, runDirectory } from "./runs"

type Target = Pick<RunMetadata, "handle" | "blockId">

type Signal = "stop-request" | "stop-ready"

function path(run: Target, signal: Signal): string {
	return join(runDirectory(run.handle), signal)
}

function matches(run: Target, signal: Signal): boolean {
	try {
		return readFileSync(path(run, signal), "utf8") === run.blockId
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
		throw error
	}
}

function publish(run: Target, signal: Signal): void {
	const target = path(run, signal)
	const temporary = `${target}.${randomUUID()}.tmp`
	writeFileSync(temporary, run.blockId, { mode: 0o600 })
	renameSync(temporary, target)
}

// Keep these parent/child signals separate from shared lifecycle metadata. Binding them
// to the Rex block prevents a previous process's acknowledgement from confirming a new one.
export function requestStop(run: Target): void {
	publish(run, "stop-request")
}

export function stopRequested(run: Target): boolean {
	return matches(run, "stop-request")
}

export function acknowledgeStop(run: Target): void {
	publish(run, "stop-ready")
}

export function stopAcknowledged(run: Target): boolean {
	return matches(run, "stop-ready")
}

export function clearStopAcknowledgement(run: Target): void {
	clearSignal(run, "stop-ready")
}

function clearSignal(run: Target, signal: Signal): void {
	try {
		unlinkSync(path(run, signal))
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
	}
}

export function clearStopSignals(run: Target): void {
	clearSignal(run, "stop-request")
	clearStopAcknowledgement(run)
}

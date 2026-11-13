import { resolve } from "node:path"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { FamilyPolicy } from "../lib/session-delivery/mailbox"
import { getRun, readMetadata, runDirectory, type RunMetadata } from "./runs"
import { stopRequested } from "./stop"

export function ownedRun({ handle, parentSessionId }: Pick<RunMetadata, "handle" | "parentSessionId">) {
	const run = getRun(handle, parentSessionId)

	if (run.parentSessionId !== parentSessionId) throw new Error(`Subagent ${handle} belongs to another parent`)

	return run
}

export function managedParent(ctx: Pick<ExtensionContext, "sessionManager">, runDir = process.env.PI_SUBAGENT_RUN_DIR) {
	if (!runDir) return undefined
	const run = readMetadata(runDir)
	const file = ctx.sessionManager.getSessionFile()

	if (
		!run ||
		!file ||
		resolve(file) !== resolve(run.sessionFile) ||
		run.childSessionId !== ctx.sessionManager.getSessionId()
	) {
		return undefined
	}

	return run.parentSessionId
}

export const familyPolicy: FamilyPolicy = (route, from, to) => {
	const parent = route.direction === "delegate" ? from : to
	const child = route.direction === "delegate" ? to : from
	let run: RunMetadata | undefined

	try {
		run = readMetadata(runDirectory(route.handle, parent.sessionId))
	} catch {
		// An unusable handle or session id owns no run.
		return false
	}

	if (!run || run.stoppedAt || run.suspended || run.relation !== route.relation) return false

	if (route.direction === "delegate" && stopRequested(run)) return false

	return (
		parent.sessionId === run.parentSessionId &&
		child.sessionId === run.childSessionId &&
		child.sessionFile !== undefined &&
		resolve(child.sessionFile) === resolve(run.sessionFile)
	)
}

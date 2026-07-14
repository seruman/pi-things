import * as fs from "node:fs"
import { type CanonicalPath, parseCanonicalPath } from "./canonical-path"
import { type RestoreScope, selectedRestoreScope } from "./restore"
import { type Result, err, ok } from "./result"
import { type RelativeSnapshotPath, type SnapshotId, parseRelativeSnapshotPath, parseSnapshotId } from "./snapshot"

export const SNAPSHOT_USAGE = `Usage:
  pi-snapshot [--project <absolute-project-root>] list
  pi-snapshot [--project <absolute-project-root>] create
  pi-snapshot [--project <absolute-project-root>] diff <snapshot> [-- <path>...]
  pi-snapshot [--project <absolute-project-root>] show <snapshot> <path>
  pi-snapshot [--project <absolute-project-root>] restore <snapshot> [--dry-run|--apply]
  pi-snapshot [--project <absolute-project-root>] restore <snapshot> [--dry-run|--apply] -- <path>...
  pi-snapshot [--project <absolute-project-root>] export <snapshot> <absolute-destination>
  pi-snapshot [--project <absolute-project-root>] verify <snapshot>
  pi-snapshot [--project <absolute-project-root>] gc

Restore defaults to dry-run. Pass --apply to mutate the project.`

export type SnapshotCommand =
	| { readonly kind: "help" }
	| { readonly kind: "list" }
	| { readonly kind: "create" }
	| { readonly kind: "diff"; readonly id: SnapshotId; readonly scope: RestoreScope }
	| { readonly kind: "show"; readonly id: SnapshotId; readonly path: RelativeSnapshotPath }
	| {
			readonly kind: "restore"
			readonly id: SnapshotId
			readonly scope: RestoreScope
			readonly execution: "apply" | "dry-run"
	  }
	| { readonly kind: "export"; readonly id: SnapshotId; readonly destination: CanonicalPath }
	| { readonly kind: "verify"; readonly id: SnapshotId }
	| { readonly kind: "gc" }

export type SnapshotProject =
	| { readonly kind: "current-directory" }
	| { readonly kind: "explicit"; readonly root: CanonicalPath }

export interface SnapshotInvocation {
	readonly project: SnapshotProject
	readonly command: SnapshotCommand
}

export type SnapshotCommandError = {
	readonly kind: "invalid-command"
	readonly args: readonly string[]
	readonly message: string
}

export function parseSnapshotInvocation(args: readonly string[]): Result<SnapshotInvocation, SnapshotCommandError> {
	let project: SnapshotProject = { kind: "current-directory" }
	let commandArgs = args
	if (args[0] === "--project") {
		if (args.length < 2) return invalid(args, "--project requires an absolute project root")
		const root = parseCanonicalPath(args[1])
		if (!root.ok || !isDirectory(root.value)) {
			return invalid(args, "--project must name an existing absolute project directory")
		}
		project = { kind: "explicit", root: root.value }
		commandArgs = args.slice(2)
	}
	const command = parseSnapshotCommand(commandArgs)
	return command.ok ? ok(Object.freeze({ project: Object.freeze(project), command: command.value })) : command
}

export function parseSnapshotCommand(args: readonly string[]): Result<SnapshotCommand, SnapshotCommandError> {
	if (args.length === 1 && (args[0] === "help" || args[0] === "--help" || args[0] === "-h")) {
		return ok({ kind: "help" })
	}
	if (args.length === 0 || (args.length === 1 && args[0] === "list")) return ok({ kind: "list" })
	if (args.length === 1 && args[0] === "create") return ok({ kind: "create" })
	if (args.length === 1 && args[0] === "gc") return ok({ kind: "gc" })
	if (args[0] === "diff" && args.length === 2) {
		const id = commandId(args[1], args)
		return id.ok ? ok({ kind: "diff", id: id.value, scope: { kind: "all" } }) : id
	}
	if (args[0] === "diff" && args.length >= 4 && args[2] === "--") {
		const id = commandId(args[1], args)
		if (!id.ok) return id
		const scope = selectedRestoreScope(args.slice(3))
		return scope.ok
			? ok({ kind: "diff", id: id.value, scope: scope.value })
			: invalid(args, `invalid diff selection: ${scope.error.kind}`)
	}
	if (args[0] === "verify" && args.length === 2) {
		const id = commandId(args[1], args)
		return id.ok ? ok({ kind: "verify", id: id.value }) : id
	}
	if (args[0] === "show" && args.length === 3) {
		const id = commandId(args[1], args)
		if (!id.ok) return id
		const relativePath = parseRelativeSnapshotPath(args[2])
		return relativePath.ok
			? ok({ kind: "show", id: id.value, path: relativePath.value })
			: invalid(args, "show path must be a normalized relative path")
	}
	if (args[0] === "restore" && args.length === 2) {
		const id = commandId(args[1], args)
		return id.ok ? ok({ kind: "restore", id: id.value, scope: { kind: "all" }, execution: "dry-run" }) : id
	}
	if (args[0] === "restore" && args.length === 3 && (args[2] === "--dry-run" || args[2] === "--apply")) {
		const id = commandId(args[1], args)
		return id.ok
			? ok({
					kind: "restore",
					id: id.value,
					scope: { kind: "all" },
					execution: args[2] === "--apply" ? "apply" : "dry-run",
				})
			: id
	}
	if (args[0] === "restore" && args.length >= 4 && args[2] === "--") {
		return selectedRestoreCommand(args, "dry-run", 3)
	}
	if (
		args[0] === "restore" &&
		args.length >= 5 &&
		(args[2] === "--dry-run" || args[2] === "--apply") &&
		args[3] === "--"
	) {
		return selectedRestoreCommand(args, args[2] === "--apply" ? "apply" : "dry-run", 4)
	}
	if (args[0] === "export" && args.length === 3) {
		const id = commandId(args[1], args)
		if (!id.ok) return id
		const destination = parseCanonicalPath(args[2])
		return destination.ok
			? ok({ kind: "export", id: id.value, destination: destination.value })
			: invalid(args, "export destination must be an absolute resolvable path")
	}
	return invalid(args, "unknown command or invalid argument combination")
}

function isDirectory(pathname: CanonicalPath): boolean {
	try {
		return fs.statSync(pathname).isDirectory()
	} catch {
		return false
	}
}

function selectedRestoreCommand(
	args: readonly string[],
	execution: "apply" | "dry-run",
	pathOffset: number,
): Result<SnapshotCommand, SnapshotCommandError> {
	const id = commandId(args[1], args)
	if (!id.ok) return id
	const scope = selectedRestoreScope(args.slice(pathOffset))
	return scope.ok
		? ok({ kind: "restore", id: id.value, scope: scope.value, execution })
		: invalid(args, `invalid restore selection: ${scope.error.kind}`)
}

function commandId(input: string, args: readonly string[]): Result<SnapshotId, SnapshotCommandError> {
	const parsed = parseSnapshotId(input)
	return parsed.ok ? parsed : invalid(args, "invalid snapshot identifier")
}

function invalid(args: readonly string[], message: string): Result<never, SnapshotCommandError> {
	return err({ kind: "invalid-command", args: Object.freeze([...args]), message })
}

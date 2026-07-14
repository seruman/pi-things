import { createHash, randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { type CanonicalPath, appendCanonicalPath, isCanonicalPathWithin, parseCanonicalPath } from "./canonical-path"
import { type FilePolicy, decideFileAccess, decideSnapshotDisposition } from "./file-policy"
import { type Result, err, ok } from "./result"

const snapshotPlanBrand: unique symbol = Symbol("SnapshotPlan")
const snapshotStoreBrand: unique symbol = Symbol("SnapshotStore")
const stagedSnapshotBrand: unique symbol = Symbol("StagedSnapshot")
const publishedSnapshotBrand: unique symbol = Symbol("PublishedSnapshotRef")
const snapshotIdBrand: unique symbol = Symbol("SnapshotId")
const relativeSnapshotPathBrand: unique symbol = Symbol("RelativeSnapshotPath")

export type SnapshotId = string & { readonly [snapshotIdBrand]: true }
export type RelativeSnapshotPath = string & { readonly [relativeSnapshotPathBrand]: true }

export type SnapshotFileStorage = { readonly kind: "ordinary" } | { readonly kind: "protected" }

export function isExcludedSnapshotPath(
	policy: FilePolicy,
	workspaceRoot: CanonicalPath,
	relativePath: RelativeSnapshotPath,
): boolean {
	const absolute = appendCanonicalPath(workspaceRoot, relativePath.split(path.sep))
	return absolute.ok && decideSnapshotDisposition(policy, absolute.value).value === "exclude"
}

export type SnapshotPlanEntry =
	| {
			readonly kind: "directory"
			readonly path: RelativeSnapshotPath
			readonly mode: number
			readonly mtimeMs: number
	  }
	| {
			readonly kind: "file"
			readonly path: RelativeSnapshotPath
			readonly mode: number
			readonly mtimeMs: number
			readonly size: number
			readonly storage: SnapshotFileStorage
	  }
	| {
			readonly kind: "symlink"
			readonly path: RelativeSnapshotPath
			readonly target: string
	  }
	| {
			readonly kind: "excluded"
			readonly path: RelativeSnapshotPath
			readonly reason: "policy"
	  }

export interface SnapshotPlan {
	readonly workspaceRoot: CanonicalPath
	readonly entries: readonly SnapshotPlanEntry[]
	readonly [snapshotPlanBrand]: true
}

export function storedSnapshotPath(
	snapshotDirectory: CanonicalPath,
	entry: Exclude<SnapshotPlanEntry, { readonly kind: "excluded" }>,
): string {
	const storageRoot = entry.kind === "file" && entry.storage.kind === "protected" ? "protected" : "tree"
	return path.join(snapshotDirectory, storageRoot, entry.path)
}

export interface NonComparableWorkspaceEntry {
	readonly path: RelativeSnapshotPath
	readonly entryType: string
}

export interface WorkspaceObservation {
	readonly entries: readonly SnapshotPlanEntry[]
	readonly nonComparable: readonly NonComparableWorkspaceEntry[]
}

export function classifySnapshotStorage(policy: FilePolicy, path: CanonicalPath): SnapshotFileStorage {
	return decideFileAccess(policy, path).value === "none" ? { kind: "protected" } : { kind: "ordinary" }
}

export interface SnapshotStore {
	readonly workspaceRoot: CanonicalPath
	readonly projectDirectory: CanonicalPath
	readonly filePolicy: FilePolicy
	readonly maxSnapshots: number
	readonly [snapshotStoreBrand]: true
}

export interface StagedSnapshot {
	readonly id: SnapshotId
	readonly stagingDirectory: CanonicalPath
	readonly finalDirectory: CanonicalPath
	readonly createdAt: string
	readonly [stagedSnapshotBrand]: true
}

export interface PublishedSnapshotRef {
	readonly id: SnapshotId
	readonly directory: CanonicalPath
	readonly createdAt: string
	readonly [publishedSnapshotBrand]: true
}

export type SnapshotError =
	| { readonly kind: "invalid-store"; readonly message: string }
	| { readonly kind: "path-resolution"; readonly path: string; readonly message: string }
	| { readonly kind: "unsupported-entry"; readonly path: string; readonly entryType: string }
	| { readonly kind: "filesystem-race"; readonly path: string; readonly expected: "directory" | "file" | "symlink" }
	| { readonly kind: "clone-unsupported"; readonly message: string }
	| { readonly kind: "project-locked"; readonly path: string }
	| { readonly kind: "retention-conflict"; readonly maxSnapshots: number }
	| { readonly kind: "io"; readonly operation: string; readonly path: string; readonly message: string }

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause)
}

function errorCode(cause: unknown): string | undefined {
	if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined
	return typeof cause.code === "string" ? cause.code : undefined
}

export function parseRelativeSnapshotPath(input: string): Result<RelativeSnapshotPath, SnapshotError> {
	if (input.length === 0 || path.isAbsolute(input) || input.includes("\0")) {
		return err({ kind: "path-resolution", path: input, message: "snapshot path must be non-empty and relative" })
	}
	const components = input.split(path.sep)
	if (components.some((component) => component === "" || component === "." || component === "..")) {
		return err({ kind: "path-resolution", path: input, message: "snapshot path contains an invalid component" })
	}
	return ok(input as RelativeSnapshotPath)
}

export function parseSnapshotId(input: string): Result<SnapshotId, SnapshotError> {
	return /^\d{17}-[0-9a-f]{16}$/.test(input)
		? ok(input as SnapshotId)
		: err({ kind: "path-resolution", path: input, message: "invalid snapshot identifier" })
}

let lastGeneratedTimestamp = 0

function generateSnapshotIdentity(): { readonly id: SnapshotId; readonly createdAt: string } {
	const timestamp = Math.max(Date.now(), lastGeneratedTimestamp + 1)
	lastGeneratedTimestamp = timestamp
	const createdAt = new Date(timestamp).toISOString()
	const compactTimestamp = createdAt.replace(/[^0-9]/g, "")
	const parsed = parseSnapshotId(`${compactTimestamp}-${randomBytes(8).toString("hex")}`)
	if (!parsed.ok) throw new TypeError("generated an invalid snapshot identifier")
	return { id: parsed.value, createdAt }
}

function entryType(stat: fs.Stats): string {
	if (stat.isFIFO()) return "fifo"
	if (stat.isSocket()) return "socket"
	if (stat.isBlockDevice()) return "block-device"
	if (stat.isCharacterDevice()) return "character-device"
	return "unknown"
}

export function createSnapshotStore(input: {
	readonly workspaceRoot: CanonicalPath
	readonly stateRoot: CanonicalPath
	readonly filePolicy: FilePolicy
	readonly maxSnapshots?: number
}): Result<SnapshotStore, SnapshotError> {
	const maxSnapshots = input.maxSnapshots ?? 20
	if (!Number.isSafeInteger(maxSnapshots) || maxSnapshots < 1) {
		return err({ kind: "invalid-store", message: "maxSnapshots must be a positive safe integer" })
	}
	const projectId = createHash("sha256").update(input.workspaceRoot).digest("hex").slice(0, 24)
	const projectDirectory = parseCanonicalPath(path.join(input.stateRoot, "pi-safety", "snapshots", projectId))
	if (!projectDirectory.ok) {
		return err({
			kind: "path-resolution",
			path: path.join(input.stateRoot, "pi-safety", "snapshots", projectId),
			message: JSON.stringify(projectDirectory.error),
		})
	}
	if (
		isCanonicalPathWithin(input.workspaceRoot, projectDirectory.value) ||
		isCanonicalPathWithin(projectDirectory.value, input.workspaceRoot)
	) {
		return err({ kind: "invalid-store", message: "snapshot store and workspace must not contain each other" })
	}
	return ok(
		Object.freeze({
			workspaceRoot: input.workspaceRoot,
			projectDirectory: projectDirectory.value,
			filePolicy: input.filePolicy,
			maxSnapshots,
		}) as SnapshotStore,
	)
}

type WorkspaceObservationInput = {
	readonly workspaceRoot: CanonicalPath
	readonly filePolicy: FilePolicy
}

type WorkspaceObservationScope =
	| { readonly kind: "all" }
	| { readonly kind: "selected"; readonly paths: readonly RelativeSnapshotPath[] }

export function observeWorkspace(input: WorkspaceObservationInput): Result<WorkspaceObservation, SnapshotError> {
	return observeWorkspaceScope(input, { kind: "all" })
}

export function observeWorkspacePaths(
	input: WorkspaceObservationInput & { readonly paths: readonly RelativeSnapshotPath[] },
): Result<WorkspaceObservation, SnapshotError> {
	return observeWorkspaceScope(input, { kind: "selected", paths: input.paths })
}

function observeWorkspaceScope(
	input: WorkspaceObservationInput,
	scope: WorkspaceObservationScope,
): Result<WorkspaceObservation, SnapshotError> {
	const entries: SnapshotPlanEntry[] = []
	const nonComparable: NonComparableWorkspaceEntry[] = []

	const visitDirectory = (relativeDirectory: string): Result<undefined, SnapshotError> => {
		const absoluteDirectory = relativeDirectory
			? path.join(input.workspaceRoot, relativeDirectory)
			: input.workspaceRoot
		let children: string[]
		try {
			children = fs.readdirSync(absoluteDirectory).sort()
		} catch (cause) {
			return err({ kind: "io", operation: "read-directory", path: absoluteDirectory, message: errorMessage(cause) })
		}
		for (const name of children) {
			const relative = relativeDirectory ? path.join(relativeDirectory, name) : name
			const parsedRelative = parseRelativeSnapshotPath(relative)
			if (!parsedRelative.ok) return parsedRelative
			const visited = visitEntry(parsedRelative.value, "required")
			if (!visited.ok) return visited
		}
		return ok(undefined)
	}

	const visitEntry = (
		relative: RelativeSnapshotPath,
		presence: "optional" | "required",
	): Result<undefined, SnapshotError> => {
		if (isExcludedSnapshotPath(input.filePolicy, input.workspaceRoot, relative)) {
			entries.push({ kind: "excluded", path: relative, reason: "policy" })
			return ok(undefined)
		}
		const absolute = path.join(input.workspaceRoot, relative)
		let stat: fs.Stats
		try {
			stat = fs.lstatSync(absolute)
		} catch (cause) {
			if (presence === "optional" && errorCode(cause) === "ENOENT") return ok(undefined)
			return err({ kind: "io", operation: "lstat", path: absolute, message: errorMessage(cause) })
		}
		if (stat.isDirectory()) {
			entries.push({ kind: "directory", path: relative, mode: stat.mode & 0o7777, mtimeMs: stat.mtimeMs })
			return visitDirectory(relative)
		}
		if (stat.isFile()) {
			const canonical = parseCanonicalPath(absolute)
			if (!canonical.ok) {
				return err({ kind: "path-resolution", path: absolute, message: JSON.stringify(canonical.error) })
			}
			if (!isCanonicalPathWithin(input.workspaceRoot, canonical.value)) {
				return err({ kind: "path-resolution", path: absolute, message: "file resolves outside workspace" })
			}
			entries.push({
				kind: "file",
				path: relative,
				mode: stat.mode & 0o7777,
				mtimeMs: stat.mtimeMs,
				size: stat.size,
				storage: classifySnapshotStorage(input.filePolicy, canonical.value),
			})
			return ok(undefined)
		}
		if (stat.isSymbolicLink()) {
			try {
				entries.push({ kind: "symlink", path: relative, target: fs.readlinkSync(absolute) })
				return ok(undefined)
			} catch (cause) {
				return err({ kind: "io", operation: "readlink", path: absolute, message: errorMessage(cause) })
			}
		}
		nonComparable.push({ path: relative, entryType: entryType(stat) })
		return ok(undefined)
	}

	if (scope.kind === "all") {
		const visited = visitDirectory("")
		if (!visited.ok) return visited
	} else {
		const roots = scope.paths
			.filter(
				(candidate) => !scope.paths.some((other) => other !== candidate && candidate.startsWith(`${other}${path.sep}`)),
			)
			.sort()
		for (const relative of roots) {
			const visited = visitEntry(relative, "optional")
			if (!visited.ok) return visited
		}
	}
	return ok(
		Object.freeze({
			entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
			nonComparable: Object.freeze(nonComparable.map((entry) => Object.freeze(entry))),
		}),
	)
}

export function planSnapshot(input: {
	readonly workspaceRoot: CanonicalPath
	readonly filePolicy: FilePolicy
}): Result<SnapshotPlan, SnapshotError> {
	const observed = observeWorkspace(input)
	if (!observed.ok) return observed
	const unsupported = observed.value.nonComparable[0]
	if (unsupported !== undefined) {
		return err({
			kind: "unsupported-entry",
			path: path.join(input.workspaceRoot, unsupported.path),
			entryType: unsupported.entryType,
		})
	}
	return ok(
		Object.freeze({
			workspaceRoot: input.workspaceRoot,
			entries: observed.value.entries,
		}) as SnapshotPlan,
	)
}

function ensureDirectory(directory: string): Result<undefined, SnapshotError> {
	try {
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
		fs.chmodSync(directory, 0o700)
		return ok(undefined)
	} catch (cause) {
		return err({ kind: "io", operation: "create-directory", path: directory, message: errorMessage(cause) })
	}
}

function probeCloneSupport(projectDirectory: CanonicalPath): Result<undefined, SnapshotError> {
	const suffix = randomBytes(8).toString("hex")
	const source = path.join(projectDirectory, `.clone-probe-${suffix}`)
	const destination = `${source}.clone`
	let probeResult: Result<undefined, SnapshotError>
	try {
		fs.writeFileSync(source, "pi-safety-clone-probe", { mode: 0o600, flag: "wx" })
		fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE_FORCE)
		probeResult = ok(undefined)
	} catch (cause) {
		probeResult = err({ kind: "clone-unsupported", message: errorMessage(cause) })
	}
	try {
		fs.rmSync(source, { force: true })
		fs.rmSync(destination, { force: true })
	} catch (cause) {
		return err({ kind: "io", operation: "clean-clone-probe", path: source, message: errorMessage(cause) })
	}
	return probeResult
}

function expectedKind(stat: fs.Stats, expected: "directory" | "file" | "symlink"): boolean {
	if (expected === "directory") return stat.isDirectory()
	if (expected === "file") return stat.isFile()
	return stat.isSymbolicLink()
}

function checkedLiveStat(
	workspaceRoot: CanonicalPath,
	entry: SnapshotPlanEntry,
	expected: "directory" | "file" | "symlink",
): Result<fs.Stats, SnapshotError> {
	const source = path.join(workspaceRoot, entry.path)
	try {
		const stat = fs.lstatSync(source)
		return expectedKind(stat, expected) ? ok(stat) : err({ kind: "filesystem-race", path: source, expected })
	} catch {
		return err({ kind: "filesystem-race", path: source, expected })
	}
}

export function stageSnapshot(
	plan: SnapshotPlan,
	projectDirectory: CanonicalPath,
): Result<StagedSnapshot, SnapshotError> {
	try {
		return stageSnapshotTransaction(plan, projectDirectory)
	} catch (cause) {
		return err({
			kind: "io",
			operation: "stage-snapshot-cleanup",
			path: projectDirectory,
			message: errorMessage(cause),
		})
	}
}

function stageSnapshotTransaction(
	plan: SnapshotPlan,
	projectDirectory: CanonicalPath,
): Result<StagedSnapshot, SnapshotError> {
	const { id, createdAt } = generateSnapshotIdentity()
	const stagingRaw = path.join(projectDirectory, `.staging-${id}`)
	const finalRaw = path.join(projectDirectory, id)
	const staging = parseCanonicalPath(stagingRaw)
	if (!staging.ok) return err({ kind: "path-resolution", path: stagingRaw, message: JSON.stringify(staging.error) })
	const finalDirectory = parseCanonicalPath(finalRaw)
	if (!finalDirectory.ok) {
		return err({ kind: "path-resolution", path: finalRaw, message: JSON.stringify(finalDirectory.error) })
	}

	let stagedSuccessfully = false
	try {
		fs.mkdirSync(staging.value, { mode: 0o700 })
		fs.mkdirSync(path.join(staging.value, "tree"), { mode: 0o700 })
		fs.mkdirSync(path.join(staging.value, "protected"), { mode: 0o700 })
		const directories: Array<{ destination: string; mode: number; mtimeMs: number }> = []
		for (const entry of plan.entries) {
			if (entry.kind === "excluded") continue
			const source = path.join(plan.workspaceRoot, entry.path)
			if (entry.kind === "directory") {
				const current = checkedLiveStat(plan.workspaceRoot, entry, "directory")
				if (!current.ok) return current
				const destination = path.join(staging.value, "tree", entry.path)
				fs.mkdirSync(destination, { recursive: true, mode: entry.mode })
				directories.push({ destination, mode: entry.mode, mtimeMs: entry.mtimeMs })
				continue
			}
			if (entry.kind === "symlink") {
				const current = checkedLiveStat(plan.workspaceRoot, entry, "symlink")
				if (!current.ok) return current
				if (fs.readlinkSync(source) !== entry.target) {
					return err({ kind: "filesystem-race", path: source, expected: "symlink" })
				}
				const destination = path.join(staging.value, "tree", entry.path)
				fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
				fs.symlinkSync(entry.target, destination)
				continue
			}
			const current = checkedLiveStat(plan.workspaceRoot, entry, "file")
			if (!current.ok || current.value.size !== entry.size) {
				return current.ok ? err({ kind: "filesystem-race", path: source, expected: "file" }) : current
			}
			const destination = storedSnapshotPath(staging.value, entry)
			fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
			fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE_FORCE)
			fs.chmodSync(destination, entry.mode)
			fs.utimesSync(destination, entry.mtimeMs / 1000, entry.mtimeMs / 1000)
		}
		for (const directory of directories.reverse()) {
			fs.chmodSync(directory.destination, directory.mode)
			fs.utimesSync(directory.destination, directory.mtimeMs / 1000, directory.mtimeMs / 1000)
		}
		const manifest = {
			version: 2,
			id,
			createdAt,
			workspace: plan.workspaceRoot,
			entries: plan.entries,
		}
		fs.writeFileSync(path.join(staging.value, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
			mode: 0o600,
			flag: "wx",
		})
		stagedSuccessfully = true
		return ok(
			Object.freeze({
				id,
				stagingDirectory: staging.value,
				finalDirectory: finalDirectory.value,
				createdAt,
			}) as StagedSnapshot,
		)
	} catch (cause) {
		return err({ kind: "io", operation: "stage-snapshot", path: staging.value, message: errorMessage(cause) })
	} finally {
		if (!stagedSuccessfully) fs.rmSync(staging.value, { recursive: true, force: true })
	}
}

export function publishSnapshot(staged: StagedSnapshot): Result<PublishedSnapshotRef, SnapshotError> {
	try {
		fs.renameSync(staged.stagingDirectory, staged.finalDirectory)
		return ok(
			Object.freeze({
				id: staged.id,
				directory: staged.finalDirectory,
				createdAt: staged.createdAt,
			}) as PublishedSnapshotRef,
		)
	} catch (cause) {
		return err({
			kind: "io",
			operation: "publish-snapshot",
			path: staged.finalDirectory,
			message: errorMessage(cause),
		})
	}
}

export function garbageCollectSnapshots(store: SnapshotStore): Result<undefined, SnapshotError> {
	return pruneSnapshots(store, new Set())
}

function pruneSnapshots(store: SnapshotStore, preserved: ReadonlySet<string>): Result<undefined, SnapshotError> {
	try {
		const published = fs
			.readdirSync(store.projectDirectory, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && parseSnapshotId(entry.name).ok)
			.map((entry) => entry.name)
			.sort()
		const expired: string[] = []
		for (const name of published) {
			if (published.length - expired.length <= store.maxSnapshots) break
			if (!preserved.has(name)) expired.push(name)
		}
		if (published.length - expired.length > store.maxSnapshots) {
			return err({ kind: "retention-conflict", maxSnapshots: store.maxSnapshots })
		}
		for (const name of expired) fs.rmSync(path.join(store.projectDirectory, name), { recursive: true })
		return ok(undefined)
	} catch (cause) {
		return err({ kind: "io", operation: "prune-snapshots", path: store.projectDirectory, message: errorMessage(cause) })
	}
}

export function createSnapshot(
	store: SnapshotStore,
	options: { readonly preserve?: SnapshotId } = {},
): Result<PublishedSnapshotRef, SnapshotError> {
	try {
		return createSnapshotTransaction(store, options)
	} catch (cause) {
		return err({
			kind: "io",
			operation: "snapshot-transaction-cleanup",
			path: store.projectDirectory,
			message: errorMessage(cause),
		})
	}
}

function createSnapshotTransaction(
	store: SnapshotStore,
	options: { readonly preserve?: SnapshotId },
): Result<PublishedSnapshotRef, SnapshotError> {
	const plan = planSnapshot({ workspaceRoot: store.workspaceRoot, filePolicy: store.filePolicy })
	if (!plan.ok) return plan
	const directory = ensureDirectory(store.projectDirectory)
	if (!directory.ok) return directory
	const lockDirectory = path.join(store.projectDirectory, ".lock")
	let lockAcquired = false
	try {
		try {
			fs.mkdirSync(lockDirectory, { mode: 0o700 })
			lockAcquired = true
		} catch (cause) {
			if (fs.existsSync(lockDirectory)) return err({ kind: "project-locked", path: lockDirectory })
			return err({ kind: "io", operation: "acquire-lock", path: lockDirectory, message: errorMessage(cause) })
		}
		const cloneSupport = probeCloneSupport(store.projectDirectory)
		if (!cloneSupport.ok) return cloneSupport
		const staged = stageSnapshot(plan.value, store.projectDirectory)
		if (!staged.ok) return staged
		const published = publishSnapshot(staged.value)
		if (!published.ok) {
			fs.rmSync(staged.value.stagingDirectory, { recursive: true, force: true })
			return published
		}
		const preserved = new Set<string>([published.value.id])
		if (options.preserve !== undefined) preserved.add(options.preserve)
		const pruned = pruneSnapshots(store, preserved)
		if (!pruned.ok) {
			fs.rmSync(published.value.directory, { recursive: true, force: true })
			return pruned
		}
		return published
	} finally {
		if (lockAcquired) fs.rmSync(lockDirectory, { recursive: true, force: true })
	}
}

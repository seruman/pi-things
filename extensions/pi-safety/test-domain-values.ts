import {
	type CanonicalExecutable,
	type CanonicalPath,
	parseCanonicalExecutable,
	parseCanonicalPath,
} from "./canonical-path"
import {
	type FilePolicy,
	type FilePolicyRule,
	defineFilePolicy,
	excludeFromSnapshots,
	noAccess,
	pattern,
	readOnly,
	readWrite,
	readWriteForExecutable,
	tree,
} from "./file-policy"
import { type PathPattern, parsePathPattern } from "./path-pattern"
import { unwrap } from "./result"

export function canonicalPath(input: string): CanonicalPath {
	return unwrap(parseCanonicalPath(input))
}

export function canonicalExecutable(input: string): CanonicalExecutable {
	return unwrap(parseCanonicalExecutable(input))
}

export function pathPattern(input: string, relativeTo: CanonicalPath): PathPattern {
	return unwrap(parsePathPattern(input, relativeTo))
}

export function testFilePolicy(
	workspace: string,
	home: string,
	options: {
		readonly noAccessPatterns?: readonly PathPattern[]
		readonly readOnlyPatterns?: readonly PathPattern[]
		readonly executableWrites?: readonly {
			readonly executable: CanonicalExecutable
			readonly patterns: readonly PathPattern[]
		}[]
		readonly snapshotExclusions?: readonly PathPattern[]
		readonly additionalRules?: readonly FilePolicyRule[]
	} = {},
): FilePolicy {
	const workspaceRoot = canonicalPath(workspace)
	const rules: FilePolicyRule[] = [
		readOnly(tree(canonicalPath("/"))),
		readWrite(tree(workspaceRoot)),
		...(options.readOnlyPatterns ?? []).map((value) => readOnly(pattern(value))),
		...(options.noAccessPatterns ?? []).map((value) => noAccess(pattern(value))),
		...(options.executableWrites ?? []).flatMap((write) =>
			write.patterns.map((value) => readWriteForExecutable(write.executable, pattern(value))),
		),
		...(options.snapshotExclusions ?? []).map((value) => excludeFromSnapshots(pattern(value))),
		...(options.additionalRules ?? []),
	]
	return defineFilePolicy({ workspaceRoot, homeRoot: canonicalPath(home), rules })
}

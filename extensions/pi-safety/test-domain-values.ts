import {
	type CanonicalExecutable,
	type CanonicalPath,
	parseCanonicalExecutable,
	parseCanonicalPath,
} from "./canonical-path"
import { type PathPattern, parsePathPattern } from "./path-pattern"
import {
	type Policy,
	type PolicyRule,
	definePolicy,
	excludeFromSnapshots,
	executable,
	noAccess,
	pattern,
	readOnly,
	readWrite,
	shared,
	tree,
} from "./policy"
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

export function testPolicy(
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
		readonly additionalRules?: readonly PolicyRule[]
	} = {},
): Policy {
	const workspaceRoot = canonicalPath(workspace)
	const rules: PolicyRule[] = [
		readOnly(shared(), tree(canonicalPath("/"))),
		readWrite(shared(), tree(workspaceRoot)),
		...(options.readOnlyPatterns ?? []).map((value) => readOnly(shared(), pattern(value))),
		...(options.noAccessPatterns ?? []).map((value) => noAccess(shared(), pattern(value))),
		...(options.executableWrites ?? []).flatMap((write) =>
			write.patterns.map((value) => readWrite(executable(write.executable), pattern(value))),
		),
		...(options.snapshotExclusions ?? []).map((value) => excludeFromSnapshots(pattern(value))),
		...(options.additionalRules ?? []),
	]
	return definePolicy({ workspaceRoot, homeRoot: canonicalPath(home), rules })
}

import * as path from "node:path"
import {
	type CanonicalExecutable,
	type CanonicalPath,
	parseCanonicalExecutable,
	parseCanonicalPath,
} from "./canonical-path"
import { type ProtectedPathPattern, parseProtectedPathPattern } from "./protected-path"
import { unwrap } from "./result"
import { type BuiltinAccessPolicy, createBuiltinAccessPolicy } from "./tool-authorization"

export function canonicalPath(input: string): CanonicalPath {
	return unwrap(parseCanonicalPath(input))
}

export function canonicalExecutable(input: string): CanonicalExecutable {
	return unwrap(parseCanonicalExecutable(input))
}

export function protectedPattern(input: string, relativeTo: CanonicalPath): ProtectedPathPattern {
	return unwrap(parseProtectedPathPattern(input, relativeTo))
}

export function testBuiltinAccessPolicy(
	workspace: string,
	home: string,
	options: {
		readonly secretPatterns?: readonly ProtectedPathPattern[]
		readonly protectedWritePatterns?: readonly ProtectedPathPattern[]
		readonly gitWritePatterns?: readonly ProtectedPathPattern[]
		readonly sshReadableMetadata?: readonly ProtectedPathPattern[]
		readonly protectedSnapshotPatterns?: readonly ProtectedPathPattern[]
		readonly immutableWriteRoots?: readonly CanonicalPath[]
	} = {},
): BuiltinAccessPolicy {
	return createBuiltinAccessPolicy({
		workspaceRoot: canonicalPath(workspace),
		homeRoot: canonicalPath(home),
		secretPatterns: options.secretPatterns ?? [],
		nonGitProtectedWritePatterns: options.protectedWritePatterns ?? [],
		gitWritePatterns: options.gitWritePatterns ?? [],
		ssh: {
			protectedRoot: canonicalPath(path.join(home, ".ssh")),
			readableMetadata: options.sshReadableMetadata ?? [],
		},
		protectedSnapshotPatterns: options.protectedSnapshotPatterns ?? [],
		immutableWriteRoots: options.immutableWriteRoots ?? [],
	})
}

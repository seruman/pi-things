import type { CanonicalPath } from "./canonical-path"
import type { AuthorizedWriteTarget, BuiltinAccessPolicy } from "./tool-authorization"

declare const canonicalPath: CanonicalPath

// @ts-expect-error Policies must come from createBuiltinAccessPolicy.
const forgedPolicy: BuiltinAccessPolicy = {
	workspaceRoot: canonicalPath,
	homeRoot: canonicalPath,
	secretPatterns: [],
	protectedWritePatterns: [],
	gitWritePatterns: [],
	ssh: { protectedRoot: canonicalPath, readableMetadata: [] },
	protectedSnapshotPatterns: [],
	immutableWriteRoots: [],
}

// @ts-expect-error Authorization proofs cannot be manufactured from canonical paths alone.
const forgedTarget: AuthorizedWriteTarget = { path: canonicalPath }

void forgedPolicy
void forgedTarget

import type { CanonicalPath } from "./canonical-path"
import type { FilePolicy } from "./file-policy"
import type { AuthorizedWriteTarget } from "./tool-authorization"

declare const canonicalPath: CanonicalPath

// @ts-expect-error Policies must come from defineFilePolicy.
const forgedPolicy: FilePolicy = {
	workspaceRoot: canonicalPath,
	homeRoot: canonicalPath,
	rules: [],
}

// @ts-expect-error Authorization proofs cannot be manufactured from canonical paths alone.
const forgedTarget: AuthorizedWriteTarget = { path: canonicalPath }

void forgedPolicy
void forgedTarget

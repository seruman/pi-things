import type { CanonicalPath } from "./canonical-path"
import type { FilePolicy, FilePolicyRule, FileSelector } from "./file-policy"

declare const canonicalPath: CanonicalPath

// @ts-expect-error Selectors must come from the controlled selector constructors.
const forgedSelector: FileSelector = { kind: "tree", path: canonicalPath }

// @ts-expect-error Rules must come from the controlled effect constructors.
const forgedRule: FilePolicyRule = { kind: "access", selector: forgedSelector, access: "read-write" }

// @ts-expect-error Policies must come from defineFilePolicy.
const forgedPolicy: FilePolicy = { workspaceRoot: canonicalPath, homeRoot: canonicalPath, rules: [] }

void forgedSelector
void forgedRule
void forgedPolicy

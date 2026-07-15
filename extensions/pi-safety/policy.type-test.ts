import type { CanonicalPath } from "./canonical-path"
import type { FileSelector, Policy, PolicyRule, RuleSubject } from "./policy"

declare const canonicalPath: CanonicalPath

// @ts-expect-error Subjects must come from controlled constructors.
const forgedSubject: RuleSubject = { kind: "shared" }

// @ts-expect-error Selectors must come from controlled constructors.
const forgedSelector: FileSelector = { kind: "tree", path: canonicalPath }

// @ts-expect-error Rules must come from controlled constructors.
const forgedRule: PolicyRule = {
	kind: "file-access",
	subject: forgedSubject,
	selector: forgedSelector,
	access: "read-write",
}

// @ts-expect-error Policies must come from definePolicy.
const forgedPolicy: Policy = { workspaceRoot: canonicalPath, homeRoot: canonicalPath, rules: [] }

void forgedSubject
void forgedSelector
void forgedRule
void forgedPolicy

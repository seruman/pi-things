import type { Policy, PolicyRule, RuleSubject } from "./policy"
import type { PathMatcher, UnixSocketMatcher } from "./sbpl"

export interface PolicyDisplayEntry {
	readonly number: number
	readonly label: string
	readonly value: string
	readonly summary: string
	readonly dsl: string
}

export function describeSeatbeltPolicy(policy: Policy): readonly PolicyDisplayEntry[] {
	return policy.rules.flatMap((rule, index) => {
		if (rule.kind === "snapshot") return []
		const readable = describeReadableRule(rule, policy)
		return [{ number: index + 1, ...readable, dsl: describeRule(rule) }]
	})
}

export function describePolicy(policy: Policy): string {
	const lines = [
		"Pi Safety policy (ordered; file and snapshot rules are last-match-wins)",
		`workspace ${quote(policy.workspaceRoot)}`,
		`home      ${quote(policy.homeRoot)}`,
		"",
	]
	for (const [index, rule] of policy.rules.entries()) {
		lines.push(`${String(index + 1).padStart(3, "0")} ${describeRule(rule)}`)
	}
	return lines.join("\n")
}

function describeReadableRule(
	rule: Exclude<PolicyRule, { readonly kind: "snapshot" }>,
	policy: Policy,
): Omit<PolicyDisplayEntry, "number" | "dsl"> {
	switch (rule.kind) {
		case "file-access":
			return {
				label: describeReadableSelector(rule.selector, policy),
				value: rule.access === "none" ? "denied" : rule.access,
				summary: `${describeReadableSubject(rule.subject)} · ${describeAccess(rule.access)}`,
			}
		case "file":
			return {
				label: "Runtime files",
				value: rule.effect,
				summary: `${rule.operations.join(", ")} · ${rule.matchers.map(describePathMatcher).join(", ")}${rule.process ? ` · ${rule.process}` : ""}`,
			}
		case "file-except-processes":
			return {
				label: "Runtime files",
				value: rule.effect,
				summary: `${rule.operations.join(", ")} · except ${rule.processes.join(", ")}`,
			}
		case "mach-lookup":
			return { label: "Mach services", value: rule.effect, summary: rule.services.map((s) => s.name).join(", ") }
		case "unix-bind":
		case "unix-connect":
			return {
				label: rule.kind === "unix-bind" ? "Unix socket bind" : "Unix socket connect",
				value: rule.effect,
				summary: rule.matchers.map(describeUnixSocketMatcher).join(", "),
			}
		case "file-extension-issue":
			return { label: "File extensions", value: rule.effect, summary: `process ${rule.process}` }
		case "broker-extension-issue":
			return { label: "Broker extension", value: "allow", summary: `${rule.extension} · ${rule.process}` }
		case "runtime-operation":
			return { label: "Runtime operations", value: rule.effect, summary: rule.operations.join(", ") }
		case "same-sandbox":
			return { label: "Same-sandbox operations", value: rule.effect, summary: rule.operations.join(", ") }
		case "ip-network":
			return { label: "IP network", value: rule.effect, summary: `${rule.operation} · ${rule.endpoint}` }
		case "network-path":
			return { label: "Network socket", value: rule.effect, summary: `${rule.operation} · ${rule.path}` }
		case "posix-ipc":
			return { label: "POSIX shared memory", value: rule.effect, summary: `${rule.operation} · ${rule.name}` }
		default:
			return rule satisfies never
	}
}

function describeRule(rule: PolicyRule): string {
	switch (rule.kind) {
		case "file-access":
			return `file ${describeSubject(rule.subject)} ${rule.access} ${describeSelector(rule.selector)}`
		case "snapshot":
			return `snapshot ${rule.disposition} ${describeSelector(rule.selector)}`
		case "file":
			return `runtime file ${rule.effect} operations=${list(rule.operations)} match=${list(rule.matchers.map(describePathMatcher))}${describeOptionalProcess(rule.process)}`
		case "file-except-processes":
			return `runtime file ${rule.effect} operations=${list(rule.operations)} match=${list(rule.matchers.map(describePathMatcher))} except=${list(rule.processes.map(quote))}`
		case "mach-lookup":
			return `runtime mach-lookup ${rule.effect} services=${list(
				rule.services.map((service) => `${service.kind}:${service.name}`),
			)}${describeOptionalProcess(rule.process)}`
		case "unix-bind":
		case "unix-connect":
			return `runtime ${rule.kind} ${rule.effect} match=${list(rule.matchers.map(describeUnixSocketMatcher))}${describeOptionalProcess(rule.process)}`
		case "file-extension-issue":
			return `runtime file-extension ${rule.effect} grants=${list(
				rule.grants.map((grant) => `${grant.extensionClass}:${list(grant.matchers.map(describePathMatcher))}`),
			)} process=${quote(rule.process)}`
		case "broker-extension-issue":
			return `runtime broker-extension allow extension=${rule.extension} process=${quote(rule.process)}`
		case "runtime-operation":
			return `runtime operations ${rule.effect} ${list(rule.operations)}`
		case "same-sandbox":
			return `runtime same-sandbox ${rule.effect} ${list(rule.operations)}`
		case "ip-network":
			return `runtime ${rule.operation} ${rule.effect} endpoint=${rule.endpoint}`
		case "network-path":
			return `runtime ${rule.operation} ${rule.effect} path=${quote(rule.path)}`
		case "posix-ipc":
			return `runtime ${rule.operation} ${rule.effect} name=${quote(rule.name)}`
		default:
			return rule satisfies never
	}
}

function describeAccess(access: Extract<PolicyRule, { readonly kind: "file-access" }>["access"]): string {
	switch (access) {
		case "none":
			return "No access"
		case "read-only":
			return "Read only"
		case "read-write":
			return "Read and write"
	}
}

function describeReadableSubject(subject: RuleSubject): string {
	switch (subject.kind) {
		case "shared":
			return "Bash and built-ins"
		case "sandbox":
			return "Bash only"
		case "executable":
			return `Executable ${subject.executable}`
	}
}

function describeReadableSelector(
	selector: Extract<PolicyRule, { readonly kind: "file-access" }>["selector"],
	policy: Policy,
): string {
	const value = selector.kind === "glob" ? selector.pattern.pattern : selector.path
	const aliased = aliasPolicyPath(value, policy)
	switch (selector.kind) {
		case "file":
		case "seatbelt-file":
			return aliased
		case "tree":
		case "seatbelt-tree":
			return aliased === "/" ? "/**" : `${aliased}/**`
		case "seatbelt-prefix":
			return `${aliased}*`
		case "glob":
			return aliased
		default:
			return selector satisfies never
	}
}

function aliasPolicyPath(value: string, policy: Policy): string {
	for (const [root, alias] of [
		[policy.workspaceRoot, "$WORKSPACE"],
		[policy.homeRoot, "$HOME"],
	] as const) {
		if (value === root) return alias
		if (value.startsWith(`${root}/`)) return `${alias}${value.slice(root.length)}`
	}
	return value
}

function describeSubject(subject: RuleSubject): string {
	switch (subject.kind) {
		case "shared":
		case "sandbox":
			return subject.kind
		case "executable":
			return `executable=${quote(subject.executable)}`
		default:
			return subject satisfies never
	}
}

function describeSelector(
	selector: Extract<PolicyRule, { readonly kind: "file-access" | "snapshot" }>["selector"],
): string {
	switch (selector.kind) {
		case "file":
		case "tree":
		case "seatbelt-file":
		case "seatbelt-tree":
		case "seatbelt-prefix":
			return `${selector.kind}=${quote(selector.path)}`
		case "glob":
			return `glob=${quote(selector.pattern.pattern)}`
		default:
			return selector satisfies never
	}
}

function describePathMatcher(matcher: PathMatcher): string {
	switch (matcher.kind) {
		case "literal":
		case "subpath":
		case "prefix":
			return `${matcher.kind}:${quote(matcher.path)}`
		case "regex":
			return `regex:${quote(matcher.pattern)}`
		default:
			return matcher satisfies never
	}
}

function describeUnixSocketMatcher(matcher: UnixSocketMatcher): string {
	switch (matcher.kind) {
		case "path":
		case "subpath":
			return `${matcher.kind}:${quote(matcher.path)}`
		default:
			return matcher satisfies never
	}
}

function describeOptionalProcess(process: string | undefined): string {
	return process === undefined ? "" : ` process=${quote(process)}`
}

function list(values: readonly string[]): string {
	return `[${values.join(", ")}]`
}

function quote(value: string): string {
	return JSON.stringify(value)
}

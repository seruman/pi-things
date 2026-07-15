import type { Policy, PolicyRule, RuleSubject } from "./policy"
import type { PathMatcher, UnixSocketMatcher } from "./sbpl"

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

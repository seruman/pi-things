import { z } from "zod"
import { DEFAULT_CAPABILITIES } from "./shell-capabilities"

export type Decision = "allow" | "deny" | "ask"

export interface Policy {
	fallback: "ask" | "deny"
	allow: Set<string>
	deny: Set<string>
}

function capabilities(value: boolean | string | undefined, flag: string): Set<string> {
	if (value === undefined || value === "") return new Set()

	const input = z.string({ invalid_type_error: `${flag} requires a comma-separated capability list` }).parse(value)
	const names = input.split(",").map((name) => name.trim())

	for (const name of names) {
		if (!DEFAULT_CAPABILITIES.some((cap) => cap.id === name)) {
			throw new Error(`${flag}: unknown capability ${JSON.stringify(name)}`)
		}
	}

	return new Set(names)
}

export function readPolicy(getFlag: (name: string) => boolean | string | undefined): Policy {
	const fallback = getFlag("shell-leash-default") ?? "ask"

	if (fallback !== "ask" && fallback !== "deny") {
		throw new Error("--shell-leash-default must be ask or deny")
	}

	return {
		fallback,
		allow: capabilities(getFlag("shell-leash-allow"), "--shell-leash-allow"),
		deny: capabilities(getFlag("shell-leash-deny"), "--shell-leash-deny"),
	}
}

export function decision(policy: Policy, approved: ReadonlySet<string>, capability: string): Decision {
	if (policy.deny.has(capability)) return "deny"

	if (policy.allow.has(capability) || approved.has(capability)) return "allow"

	return policy.fallback
}

/** Snapshot effective permissions; children must never wait for an unseen approval dialog. */
export function childFlags(policy: Policy, approved: ReadonlySet<string>): string[] {
	const allow: string[] = []
	const deny: string[] = []

	for (const { id } of DEFAULT_CAPABILITIES) {
		if (decision(policy, approved, id) === "allow") allow.push(id)
		else deny.push(id)
	}

	const args = ["--shell-leash-default", "deny"]

	if (allow.length) args.push("--shell-leash-allow", allow.join(","))

	if (deny.length) args.push("--shell-leash-deny", deny.join(","))

	return args
}

import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import {
	allowIpNetwork,
	allowRuntime,
	definePolicy,
	evaluatePolicy,
	globalMachService,
	machLookupRule,
	noAccess,
	readOnly,
	shared,
	tree,
} from "./policy"
import { unwrap } from "./result"
import { emitSeatbelt } from "./seatbelt"
import { canonicalPath } from "./test-domain-values"
import { assertDenied, runWithSeatbeltProfile } from "./test-seatbelt"
import { withTestTempDirectory } from "./test-temp-directory"

test("the policy VM preserves a narrow read exception inside a denied tree", () => {
	const protectedDirectory = canonicalPath("/tmp/pi-safety-policy-vm/protected")
	const publicDirectory = canonicalPath(path.join(protectedDirectory, "public"))
	const policy = definePolicy({
		workspaceRoot: canonicalPath("/tmp/pi-safety-policy-vm/workspace"),
		homeRoot: canonicalPath("/tmp/pi-safety-policy-vm/home"),
		rules: [
			readOnly(shared(), tree(canonicalPath("/"))),
			noAccess(shared(), tree(protectedDirectory)),
			readOnly(shared(), tree(publicDirectory)),
		],
	})

	const readable = evaluatePolicy(policy, {
		kind: "file-access",
		operation: "read",
		subject: { kind: "builtin" },
		path: canonicalPath(path.join(publicDirectory, "metadata.txt")),
	})
	assert.equal(readable.effect, "allow")
	assert.equal(readable.access, "read-only")

	const denied = evaluatePolicy(policy, {
		kind: "file-access",
		operation: "read",
		subject: { kind: "builtin" },
		path: canonicalPath(path.join(protectedDirectory, "private.txt")),
	})
	assert.equal(denied.effect, "deny")
	assert.equal(denied.access, "none")
})

test("declarative rules cannot be placed after runtime capabilities", () => {
	assert.throws(
		() =>
			definePolicy({
				workspaceRoot: canonicalPath("/tmp/pi-safety-policy-order/workspace"),
				homeRoot: canonicalPath("/tmp/pi-safety-policy-order/home"),
				rules: [allowRuntime(["process-exec"]), readOnly(shared(), tree(canonicalPath("/")))],
			}),
		/declarative policy rules must precede runtime rules/,
	)
})

test("runtime operation domains are inapplicable to built-in file evaluation", () => {
	const root = canonicalPath("/")
	const policy = definePolicy({
		workspaceRoot: canonicalPath("/tmp/pi-safety-policy-domains/workspace"),
		homeRoot: canonicalPath("/tmp/pi-safety-policy-domains/home"),
		rules: [
			readOnly(shared(), tree(root)),
			machLookupRule({
				effect: "deny",
				services: [unwrap(globalMachService("com.example.policy-test"))],
			}),
			allowIpNetwork({ operation: "network-outbound", endpoint: "remote" }),
		],
	})

	const decision = evaluatePolicy(policy, {
		kind: "file-access",
		operation: "read",
		subject: { kind: "builtin" },
		path: canonicalPath("/tmp/pi-safety-policy-domains/public.txt"),
	})
	assert.equal(decision.effect, "allow")
	assert.equal(decision.access, "read-only")
})

test("the Seatbelt adapter enforces the same narrow read exception as the policy VM", () => {
	withTestTempDirectory("policy-seatbelt-parity-", (root) => {
		const workspace = path.join(root, "workspace")
		const home = path.join(root, "home")
		const protectedDirectory = path.join(home, "protected")
		const publicDirectory = path.join(protectedDirectory, "public")
		for (const directory of [workspace, home, protectedDirectory, publicDirectory]) {
			fs.mkdirSync(directory)
		}
		const publicFile = path.join(publicDirectory, "metadata.txt")
		const privateFile = path.join(protectedDirectory, "private.txt")
		fs.writeFileSync(publicFile, "public metadata")
		fs.writeFileSync(privateFile, "private material")
		const policy = definePolicy({
			workspaceRoot: canonicalPath(workspace),
			homeRoot: canonicalPath(home),
			rules: [
				readOnly(shared(), tree(canonicalPath("/"))),
				noAccess(shared(), tree(canonicalPath(protectedDirectory))),
				readOnly(shared(), tree(canonicalPath(publicDirectory))),
				allowRuntime(["process-exec"]),
			],
		})

		const profile = emitSeatbelt(policy)
		const readable = runWithSeatbeltProfile(profile, "/bin/cat", [publicFile], workspace)
		assert.equal(readable.status, 0, readable.stderr)
		assert.equal(readable.stdout, "public metadata")
		assertDenied(runWithSeatbeltProfile(profile, "/bin/cat", [privateFile], workspace))
	})
})

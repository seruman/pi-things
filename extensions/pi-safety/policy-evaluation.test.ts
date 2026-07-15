import { describe, expect, test } from "bun:test"
import * as path from "node:path"
import {
	type EvaluationSubject,
	definePolicy,
	evaluatePolicy,
	excludeFromSnapshots,
	executable,
	file,
	includeInSnapshots,
	noAccess,
	pattern,
	readOnly,
	readWrite,
	sandbox,
	shared,
	tree,
} from "./policy"
import { canonicalExecutable, canonicalPath, pathPattern } from "./test-domain-values"

describe("ordered policy evaluation", () => {
	const root = canonicalPath("/")
	const workspace = canonicalPath("/tmp/pi-safety-policy-workspace")
	const home = canonicalPath("/Users/tester")
	const git = canonicalExecutable("/usr/bin/git")
	const other = canonicalExecutable("/bin/bash")

	const policy = definePolicy({
		workspaceRoot: workspace,
		homeRoot: home,
		rules: [
			readOnly(shared(), tree(root)),
			readWrite(shared(), tree(workspace)),
			noAccess(shared(), pattern(pathPattern(path.join(workspace, "**", ".env*"), workspace))),
			readOnly(shared(), tree(pathValue(path.join(workspace, ".git")))),
			readWrite(executable(git), tree(pathValue(path.join(workspace, ".git")))),
			excludeFromSnapshots(tree(pathValue(path.join(workspace, "generated")))),
			includeInSnapshots(tree(pathValue(path.join(workspace, "generated", "keep")))),
			readOnly(shared(), tree(pathValue(path.join(workspace, "reference-data")))),
			excludeFromSnapshots(tree(pathValue(path.join(workspace, "reference-data")))),
		],
	})

	test("later access rules win for each explicit subject", () => {
		expect(access(path.join(workspace, "src", "index.ts"), { kind: "builtin" })).toBe("read-write")
		expect(access(path.join(workspace, ".env.local"), { kind: "builtin" })).toBe("none")
		expect(access(path.join(workspace, ".git", "config"), { kind: "builtin" })).toBe("read-only")
		expect(access(path.join(workspace, ".git", "config"), { kind: "executable", executable: git })).toBe("read-write")
		expect(access(path.join(workspace, ".git", "config"), { kind: "executable", executable: other })).toBe("read-only")
	})

	test("sandbox capabilities apply to sandboxed executables but not built-ins", () => {
		const privateTemp = pathValue(path.join(workspace, "private-temp"))
		const subjectPolicy = definePolicy({
			workspaceRoot: workspace,
			homeRoot: home,
			rules: [readOnly(shared(), tree(root)), readWrite(sandbox(), tree(privateTemp))],
		})
		const accessFor = (subject: EvaluationSubject) =>
			evaluatePolicy(subjectPolicy, {
				kind: "file-access",
				operation: "write",
				subject,
				path: pathValue(path.join(privateTemp, "file")),
			}).effect
		expect(accessFor({ kind: "builtin" })).toBe("deny")
		expect(accessFor({ kind: "sandbox" })).toBe("allow")
		expect(accessFor({ kind: "executable", executable: git })).toBe("allow")
	})

	test("access and snapshot inclusion are independent", () => {
		const readableExcluded = pathValue(path.join(workspace, "reference-data", "manual.txt"))
		expect(access(readableExcluded, { kind: "builtin" })).toBe("read-only")
		expect(evaluatePolicy(policy, { kind: "snapshot", path: readableExcluded }).disposition).toBe("exclude")

		const writableExcluded = pathValue(path.join(workspace, "generated", "output.js"))
		expect(access(writableExcluded, { kind: "builtin" })).toBe("read-write")
		expect(evaluatePolicy(policy, { kind: "snapshot", path: writableExcluded }).disposition).toBe("exclude")
		expect(
			evaluatePolicy(policy, {
				kind: "snapshot",
				path: pathValue(path.join(workspace, "generated", "keep", "saved.js")),
			}).disposition,
		).toBe("include")

		const protectedIncluded = pathValue(path.join(workspace, ".env.local"))
		expect(access(protectedIncluded, { kind: "builtin" })).toBe("none")
		expect(evaluatePolicy(policy, { kind: "snapshot", path: protectedIncluded }).disposition).toBe("include")
	})

	test("file selectors do not match descendants", () => {
		const exact = pathValue(path.join(workspace, "one"))
		const exactPolicy = definePolicy({
			workspaceRoot: workspace,
			homeRoot: home,
			rules: [readOnly(shared(), tree(root)), noAccess(shared(), file(exact))],
		})
		expect(
			evaluatePolicy(exactPolicy, {
				kind: "file-access",
				operation: "read",
				subject: { kind: "builtin" },
				path: exact,
			}).access,
		).toBe("none")
		expect(
			evaluatePolicy(exactPolicy, {
				kind: "file-access",
				operation: "read",
				subject: { kind: "builtin" },
				path: pathValue(path.join(exact, "child")),
			}).access,
		).toBe("read-only")
	})

	function access(
		input: string,
		subject:
			| { readonly kind: "builtin" }
			| { readonly kind: "executable"; readonly executable: ReturnType<typeof canonicalExecutable> },
	) {
		return evaluatePolicy(policy, {
			kind: "file-access",
			operation: "read",
			subject,
			path: pathValue(input),
		}).access
	}
})

function pathValue(input: string) {
	return canonicalPath(input)
}

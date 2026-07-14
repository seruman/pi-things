import { describe, expect, test } from "bun:test"
import * as path from "node:path"
import {
	decideFileAccess,
	decideSnapshotDisposition,
	defineFilePolicy,
	excludeFromSnapshots,
	file,
	includeInSnapshots,
	noAccess,
	pattern,
	readOnly,
	readWrite,
	readWriteForExecutable,
	tree,
} from "./file-policy"
import { canonicalExecutable, canonicalPath, pathPattern } from "./test-domain-values"

describe("effect-based file policy", () => {
	const root = canonicalPath("/")
	const workspace = canonicalPath("/tmp/pi-safety-policy-workspace")
	const home = canonicalPath("/Users/tester")
	const git = canonicalExecutable("/usr/bin/git")
	const other = canonicalExecutable("/bin/bash")

	const policy = defineFilePolicy({
		workspaceRoot: workspace,
		homeRoot: home,
		rules: [
			readOnly(tree(root)),
			readWrite(tree(workspace)),
			noAccess(pattern(pathPattern(path.join(workspace, "**", ".env*"), workspace))),
			readOnly(tree(pathValue(path.join(workspace, ".git")))),
			readWriteForExecutable(git, tree(pathValue(path.join(workspace, ".git")))),
			excludeFromSnapshots(tree(pathValue(path.join(workspace, "generated")))),
			includeInSnapshots(tree(pathValue(path.join(workspace, "generated", "keep")))),
			readOnly(tree(pathValue(path.join(workspace, "reference-data")))),
			excludeFromSnapshots(tree(pathValue(path.join(workspace, "reference-data")))),
		],
	})

	test("later matching access rules win independently for each executable", () => {
		expect(decideFileAccess(policy, pathValue(path.join(workspace, "src", "index.ts"))).value).toBe("read-write")
		expect(decideFileAccess(policy, pathValue(path.join(workspace, ".env.local"))).value).toBe("none")
		expect(decideFileAccess(policy, pathValue(path.join(workspace, ".git", "config"))).value).toBe("read-only")
		expect(decideFileAccess(policy, pathValue(path.join(workspace, ".git", "config")), git).value).toBe("read-write")
		expect(decideFileAccess(policy, pathValue(path.join(workspace, ".git", "config")), other).value).toBe("read-only")
	})

	test("access and snapshot inclusion are independent", () => {
		const readableExcluded = pathValue(path.join(workspace, "reference-data", "manual.txt"))
		expect(decideFileAccess(policy, readableExcluded).value).toBe("read-only")
		expect(decideSnapshotDisposition(policy, readableExcluded).value).toBe("exclude")

		const writableExcluded = pathValue(path.join(workspace, "generated", "output.js"))
		expect(decideFileAccess(policy, writableExcluded).value).toBe("read-write")
		expect(decideSnapshotDisposition(policy, writableExcluded).value).toBe("exclude")
		expect(
			decideSnapshotDisposition(policy, pathValue(path.join(workspace, "generated", "keep", "saved.js"))).value,
		).toBe("include")

		const protectedIncluded = pathValue(path.join(workspace, ".env.local"))
		expect(decideFileAccess(policy, protectedIncluded).value).toBe("none")
		expect(decideSnapshotDisposition(policy, protectedIncluded).value).toBe("include")
	})

	test("file selectors do not match descendants", () => {
		const exact = pathValue(path.join(workspace, "one"))
		const exactPolicy = defineFilePolicy({
			workspaceRoot: workspace,
			homeRoot: home,
			rules: [readOnly(tree(root)), noAccess(file(exact))],
		})
		expect(decideFileAccess(exactPolicy, exact).value).toBe("none")
		expect(decideFileAccess(exactPolicy, pathValue(path.join(exact, "child"))).value).toBe("read-only")
	})
})

function pathValue(input: string) {
	return canonicalPath(input)
}

import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { canonicalPath, pathPattern, testFilePolicy } from "./test-domain-values"
import { withTestTempDirectory } from "./test-temp-directory"
import { authorizeBuiltinToolCall } from "./tool-authorization"

function withWorkspace(run: (fixture: { root: string; workspace: string; home: string }) => void): void {
	withTestTempDirectory("tool-authorization-", (root) => {
		const workspace = path.join(root, "workspace")
		const home = path.join(root, "home")
		fs.mkdirSync(workspace)
		fs.mkdirSync(home)
		run({ root, workspace, home })
	})
}

test("classifies Bash and rejects malformed guarded tool input", () => {
	withWorkspace(({ workspace, home }) => {
		const policy = testFilePolicy(workspace, home)

		assert.deepEqual(authorizeBuiltinToolCall("bash", { command: "true" }, policy), {
			ok: true,
			value: { kind: "bash" },
		})
		assert.deepEqual(authorizeBuiltinToolCall("read", { path: 42 }, policy), {
			ok: false,
			error: {
				kind: "invalid-tool-input",
				tool: "read",
				reason: "expected an object with a string path",
			},
		})
	})
})

test("authorizes workspace writes and rejects writes outside the workspace", () => {
	withWorkspace(({ root, workspace, home }) => {
		const outside = path.join(root, "outside.txt")

		const policy = testFilePolicy(workspace, home)

		assert.deepEqual(authorizeBuiltinToolCall("write", { path: "inside.txt", content: "safe" }, policy), {
			ok: true,
			value: { kind: "write" },
		})

		const denied = authorizeBuiltinToolCall("write", { path: outside, content: "unsafe" }, policy)
		assert.equal(denied.ok, false)
		if (!denied.ok) {
			assert.equal(denied.error.kind, "access-denied")
			if (denied.error.kind === "access-denied") {
				assert.equal(denied.error.path, outside)
				assert.equal(denied.error.actual, "read-only")
			}
		}
	})
})

test("rejects edits that escape the workspace through a symlink", () => {
	withWorkspace(({ root, workspace, home }) => {
		const outside = path.join(root, "outside")
		fs.mkdirSync(outside)
		fs.writeFileSync(path.join(outside, "target.txt"), "original")
		fs.symlinkSync(outside, path.join(workspace, "escape"))

		const policy = testFilePolicy(workspace, home)
		const denied = authorizeBuiltinToolCall(
			"edit",
			{ path: "escape/target.txt", edits: [{ oldText: "original", newText: "changed" }] },
			policy,
		)

		assert.equal(denied.ok, false)
		if (!denied.ok) {
			assert.equal(denied.error.kind, "access-denied")
			assert.equal(denied.error.tool, "edit")
			if (denied.error.kind === "access-denied") {
				assert.equal(denied.error.path, path.join(outside, "target.txt"))
			}
		}
	})
})

test("rejects no-access and read-only write targets inside the workspace", () => {
	withWorkspace(({ workspace, home }) => {
		const extensionState = path.join(workspace, ".pi")
		fs.mkdirSync(extensionState)
		const canonicalWorkspace = canonicalPath(workspace)

		const policy = testFilePolicy(workspace, home, {
			noAccessPatterns: [pathPattern(path.join(workspace, "**", ".env"), canonicalWorkspace)],
			readOnlyPatterns: [pathPattern(extensionState, canonicalWorkspace)],
		})

		const secret = authorizeBuiltinToolCall("write", { path: ".env", content: "token=secret" }, policy)
		assert.equal(secret.ok, false)
		if (!secret.ok) assert.equal(secret.error.kind, "access-denied")

		const immutable = authorizeBuiltinToolCall(
			"edit",
			{ path: ".pi/settings.json", edits: [{ oldText: "a", newText: "b" }] },
			policy,
		)
		assert.equal(immutable.ok, false)
		if (!immutable.ok) assert.equal(immutable.error.kind, "access-denied")
	})
})

test("allows ordinary reads but denies the no-access fallback path Pi would select", () => {
	withWorkspace(({ root, workspace, home }) => {
		const publicFile = path.join(root, "public.txt")
		const protectedFile = path.join(workspace, "Capture d’archive.txt")
		fs.writeFileSync(publicFile, "public")
		fs.writeFileSync(protectedFile, "secret")
		const canonicalWorkspace = canonicalPath(workspace)

		const policy = testFilePolicy(workspace, home, {
			noAccessPatterns: [pathPattern(protectedFile, canonicalWorkspace)],
		})

		assert.deepEqual(authorizeBuiltinToolCall("read", { path: publicFile }, policy), {
			ok: true,
			value: { kind: "read" },
		})

		const denied = authorizeBuiltinToolCall("read", { path: "Capture d'archive.txt" }, policy)
		assert.equal(denied.ok, false)
		if (!denied.ok) {
			assert.equal(denied.error.kind, "access-denied")
			if (denied.error.kind === "access-denied") assert.equal(denied.error.path, protectedFile)
		}
	})
})

import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { canonicalPath, protectedPattern, testBuiltinAccessPolicy } from "./test-domain-values"
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
		const policy = testBuiltinAccessPolicy(workspace, home)

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

		const policy = testBuiltinAccessPolicy(workspace, home)

		const allowed = authorizeBuiltinToolCall("write", { path: "inside.txt", content: "safe" }, policy)
		assert.equal(allowed.ok, true)
		if (allowed.ok) {
			assert.equal(allowed.value.kind, "write")
			if (allowed.value.kind === "write") {
				assert.equal(allowed.value.target.path, path.join(workspace, "inside.txt"))
			}
		}

		const denied = authorizeBuiltinToolCall("write", { path: outside, content: "unsafe" }, policy)
		assert.deepEqual(denied, {
			ok: false,
			error: {
				kind: "outside-workspace",
				tool: "write",
				path: outside,
				workspaceRoot: workspace,
			},
		})
	})
})

test("rejects edits that escape the workspace through a symlink", () => {
	withWorkspace(({ root, workspace, home }) => {
		const outside = path.join(root, "outside")
		fs.mkdirSync(outside)
		fs.writeFileSync(path.join(outside, "target.txt"), "original")
		fs.symlinkSync(outside, path.join(workspace, "escape"))

		const policy = testBuiltinAccessPolicy(workspace, home)
		const denied = authorizeBuiltinToolCall(
			"edit",
			{ path: "escape/target.txt", edits: [{ oldText: "original", newText: "changed" }] },
			policy,
		)

		assert.equal(denied.ok, false)
		if (!denied.ok) {
			assert.equal(denied.error.kind, "outside-workspace")
			assert.equal(denied.error.tool, "edit")
			if (denied.error.kind === "outside-workspace") {
				assert.equal(denied.error.path, path.join(outside, "target.txt"))
			}
		}
	})
})

test("rejects secret and immutable write targets inside the workspace", () => {
	withWorkspace(({ workspace, home }) => {
		const extensionState = path.join(workspace, ".pi")
		fs.mkdirSync(extensionState)
		const canonicalWorkspace = canonicalPath(workspace)

		const policy = testBuiltinAccessPolicy(workspace, home, {
			secretPatterns: [protectedPattern(path.join(workspace, "**", ".env"), canonicalWorkspace)],
			immutableWriteRoots: [canonicalPath(extensionState)],
		})

		const secret = authorizeBuiltinToolCall("write", { path: ".env", content: "token=secret" }, policy)
		assert.equal(secret.ok, false)
		if (!secret.ok) assert.equal(secret.error.kind, "secret-path")

		const immutable = authorizeBuiltinToolCall(
			"edit",
			{ path: ".pi/settings.json", edits: [{ oldText: "a", newText: "b" }] },
			policy,
		)
		assert.equal(immutable.ok, false)
		if (!immutable.ok) assert.equal(immutable.error.kind, "immutable-write-root")
	})
})

test("allows ordinary reads but denies the protected fallback path Pi would select", () => {
	withWorkspace(({ root, workspace, home }) => {
		const publicFile = path.join(root, "public.txt")
		const protectedFile = path.join(workspace, "Capture d’archive.txt")
		fs.writeFileSync(publicFile, "public")
		fs.writeFileSync(protectedFile, "secret")
		const canonicalWorkspace = canonicalPath(workspace)

		const policy = testBuiltinAccessPolicy(workspace, home, {
			secretPatterns: [protectedPattern(protectedFile, canonicalWorkspace)],
		})

		const allowed = authorizeBuiltinToolCall("read", { path: publicFile }, policy)
		assert.equal(allowed.ok, true)
		if (allowed.ok) {
			assert.equal(allowed.value.kind, "read")
			if (allowed.value.kind === "read") assert.equal(allowed.value.source.path, publicFile)
		}

		const denied = authorizeBuiltinToolCall("read", { path: "Capture d'archive.txt" }, policy)
		assert.equal(denied.ok, false)
		if (!denied.ok) {
			assert.equal(denied.error.kind, "secret-path")
			if (denied.error.kind === "secret-path") assert.equal(denied.error.path, protectedFile)
		}
	})
})

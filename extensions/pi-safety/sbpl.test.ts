import { test } from "bun:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { unwrap } from "./result"
import {
	allowFileExtensionIssue,
	allowFileExtensionIssues,
	allowWebKitBrokerExtension,
	emitSbpl,
	fileRule,
	fileRuleExceptProcess,
	globalMachService,
	literal,
	machLookupRule,
	subpath,
	unixBindRule,
	unixConnectRule,
	unixSocketPath,
	xpcMachService,
} from "./sbpl"
import { canonicalExecutable, canonicalPath } from "./test-domain-values"
import { runWithSeatbelt } from "./test-seatbelt"
import { withTestTempDirectory } from "./test-temp-directory"

function assertSandboxAccepts(compiled: ReturnType<typeof emitSbpl>): void {
	const result = runWithSeatbelt(compiled, "/usr/bin/true")
	assert.equal(result.status, 0, result.stderr)
}

test("emits file rules through stable sandbox parameters", () => {
	const tmp = canonicalPath("/tmp")
	const usr = canonicalPath("/usr")
	const compiled = emitSbpl([
		fileRule({
			effect: "deny",
			operations: ["file-read*", "file-write-unlink"],
			matchers: [literal(tmp), subpath(usr)],
		}),
	])

	assert.equal(
		compiled.source,
		[
			"(deny file-read* file-write-unlink",
			'  (literal (param "PI_SAFETY_0"))',
			'  (subpath (param "PI_SAFETY_1"))',
			")",
		].join("\n"),
	)
	assert.deepEqual(compiled.parameters, [
		{ name: "PI_SAFETY_0", value: tmp },
		{ name: "PI_SAFETY_1", value: usr },
	])
})

test("emits process exclusions without allowing mixed process scopes", () => {
	const executable = canonicalExecutable("/usr/bin/true")
	const tmp = canonicalPath("/tmp")
	const compiled = emitSbpl([
		fileRuleExceptProcess({
			effect: "deny",
			operations: ["file-write*"],
			matchers: [subpath(tmp)],
			process: executable,
		}),
	])
	assert.equal(
		compiled.source,
		[
			'(with-filter (require-not (process-path (param "PI_SAFETY_0")))',
			"  (deny file-write*",
			'    (subpath (param "PI_SAFETY_1"))',
			"  )",
			")",
		].join("\n"),
	)
	assertSandboxAccepts(compiled)
})

test("keeps global and XPC Mach service filters distinct", () => {
	const executable = canonicalExecutable("/usr/bin/true")
	const global = unwrap(globalMachService("com.apple.nsurlsessiond"))
	const xpc = unwrap(xpcMachService("com.apple.WebKit.Networking"))
	const compiled = emitSbpl([machLookupRule({ effect: "allow", services: [global, xpc], process: executable })])

	assert.equal(
		compiled.source,
		[
			'(with-filter (process-path (param "PI_SAFETY_0"))',
			"  (allow mach-lookup",
			'    (global-name (param "PI_SAFETY_1"))',
			'    (xpc-service-name (param "PI_SAFETY_2"))',
			"  )",
			")",
		].join("\n"),
	)
	assert.deepEqual(
		compiled.parameters.map((parameter) => parameter.value),
		[executable, "com.apple.nsurlsessiond", "com.apple.WebKit.Networking"],
	)
})

test("encodes Unix connect and bind as different rule variants", () => {
	const socket = unixSocketPath(canonicalPath("/tmp/pi-safety.sock"))
	const compiled = emitSbpl([
		unixConnectRule({ effect: "allow", matchers: [socket] }),
		unixBindRule({ effect: "deny", matchers: [socket] }),
	])

	assert.equal(
		compiled.source,
		[
			"(allow network-outbound",
			'  (remote unix-socket (path (param "PI_SAFETY_0")))',
			")",
			"(deny network-bind",
			'  (local unix-socket (path (param "PI_SAFETY_0")))',
			")",
		].join("\n"),
	)
	assert.equal(compiled.parameters.length, 1)
})

test("constrains file extension issuance by class, paths, and process", () => {
	const executable = canonicalExecutable("/usr/bin/true")
	const compiled = emitSbpl([
		allowFileExtensionIssue({
			extensionClass: "com.apple.app-sandbox.read-write",
			matchers: [subpath(canonicalPath("/tmp")), subpath(canonicalPath("/usr"))],
			process: executable,
		}),
	])

	assert.equal(
		compiled.source,
		[
			'(with-filter (process-path (param "PI_SAFETY_0"))',
			"  (allow file-issue-extension",
			"    (require-all",
			'      (extension-class "com.apple.app-sandbox.read-write")',
			"      (require-any",
			'        (subpath (param "PI_SAFETY_1"))',
			'        (subpath (param "PI_SAFETY_2"))',
			"      )",
			"    )",
			"  )",
			")",
		].join("\n"),
	)
})

test("groups multiple path-constrained extension classes into one issuance rule", () => {
	const process = canonicalExecutable("/usr/bin/true")
	const compiled = emitSbpl([
		allowFileExtensionIssues({
			grants: [
				{ extensionClass: "com.apple.app-sandbox.read", matchers: [subpath(canonicalPath("/tmp"))] },
				{ extensionClass: "com.apple.app-sandbox.read-write", matchers: [subpath(canonicalPath("/private/tmp"))] },
			],
			process,
		}),
	])
	assert.equal((compiled.source.match(/allow file-issue-extension/g) ?? []).length, 1)
	assert.equal((compiled.source.match(/require-all/g) ?? []).length, 2)
})

test("maps WebKit broker capabilities to fixed extension classes", () => {
	const executable = canonicalExecutable("/usr/bin/true")
	const compiled = emitSbpl([
		allowWebKitBrokerExtension("generic", executable),
		allowWebKitBrokerExtension("iokit", executable),
		allowWebKitBrokerExtension("mach", executable),
	])

	assert.match(compiled.source, /generic-issue-extension.*com\.apple\.webkit\.mach-bootstrap/)
	assert.match(compiled.source, /iokit-issue-extension.*com\.apple\.webkit\.extension\.iokit/)
	assert.match(compiled.source, /mach-issue-extension.*com\.apple\.webkit\.extension\.mach/)
	assert.equal(compiled.parameters.length, 1)
})

test("keeps hostile path bytes out of generated SBPL source", () => {
	withTestTempDirectory("pi-safety-sbpl-", (root) => {
		const hostile = path.join(root, 'evil")\n(allow file-read*)')
		fs.mkdirSync(hostile)
		const canonical = canonicalPath(hostile)
		const compiled = emitSbpl([
			fileRule({ effect: "allow", operations: ["file-read*"], matchers: [subpath(canonical)] }),
		])

		assert.doesNotMatch(compiled.source, /evil|allow file-read\*\)/)
		assert.deepEqual(compiled.parameters, [{ name: "PI_SAFETY_0", value: canonical }])
		assertSandboxAccepts(compiled)
	})
})

test("generated hostile path components remain isolated in parameters", () => {
	withTestTempDirectory("pi-safety-sbpl-generated-", (root) => {
		for (let index = 0; index < 32; index += 1) {
			const hostile = path.join(root, `case-${index}-'\"$()[];\n-${String.fromCodePoint(0x3b1 + (index % 20))}`)
			fs.mkdirSync(hostile)
			const canonical = canonicalPath(hostile)
			const compiled = emitSbpl([
				fileRule({ effect: "allow", operations: ["file-read*"], matchers: [subpath(canonical)] }),
			])
			assert.equal(compiled.source.includes(path.basename(hostile)), false)
			assert.deepEqual(compiled.parameters, [{ name: "PI_SAFETY_0", value: canonical }])
		}
	})
})

test("sandbox-exec accepts emitted rules and parameter definitions", () => {
	const executable = canonicalExecutable("/usr/bin/true")
	const socket = unixSocketPath(canonicalPath("/tmp/pi-safety.sock"))
	const rules = [
		fileRule({ effect: "allow", operations: ["file-read*"], matchers: [subpath(canonicalPath("/tmp"))] }),
		machLookupRule({
			effect: "allow",
			services: [
				unwrap(globalMachService("com.apple.nsurlsessiond")),
				unwrap(xpcMachService("com.apple.WebKit.Networking")),
			],
			process: executable,
		}),
		unixConnectRule({ effect: "allow", matchers: [socket], process: executable }),
		unixBindRule({ effect: "allow", matchers: [socket], process: executable }),
		allowFileExtensionIssue({
			extensionClass: "com.apple.app-sandbox.read",
			matchers: [subpath(canonicalPath("/tmp"))],
			process: executable,
		}),
		allowWebKitBrokerExtension("generic", executable),
		allowWebKitBrokerExtension("iokit", executable),
		allowWebKitBrokerExtension("mach", executable),
	]
	assertSandboxAccepts(emitSbpl(rules))
})

test("rejects malformed Mach service names at their parsing boundary", () => {
	for (const input of ["", "contains space", 'quote"breakout', "line\nbreak"]) {
		const parsed = globalMachService(input)
		assert.equal(parsed.ok, false, input)
		if (!parsed.ok) assert.equal(parsed.error.kind, "invalid-mach-service-name")
	}
})

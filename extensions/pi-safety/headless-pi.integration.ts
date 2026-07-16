import { test } from "bun:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { withPrivateTmpDirectory, withTestTempDirectory } from "./test-temp-directory"

interface HeadlessFixture {
	readonly root: string
	readonly workspace: string
	readonly home: string
	readonly stateHome: string
	readonly configHome: string
	readonly cacheHome: string
	readonly temp: string
	readonly piConfig: string
}

function createFixture(root: string): HeadlessFixture {
	const fixture = {
		root,
		workspace: path.join(root, "workspace"),
		home: path.join(root, "home"),
		stateHome: path.join(root, "state"),
		configHome: path.join(root, "config"),
		cacheHome: path.join(root, "cache"),
		temp: path.join(root, "tmp"),
		piConfig: path.join(root, "pi-config"),
	}
	for (const directory of Object.values(fixture)) fs.mkdirSync(directory, { recursive: true })
	return fixture
}

function writeShellLeashFixtureExecutable(fixtureRoot: string, name: string, nonce: string, body: string): string {
	const executable = path.join(fixtureRoot, name)
	const relative = path.relative(fixtureRoot, executable)
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("fixture executable escaped its root")
	fs.writeFileSync(executable, `#!/bin/sh\n[ "$SHELL_LEASH_TEST_NONCE" = "${nonce}" ] || exit 97\n${body}`, {
		mode: 0o700,
	})
	return executable
}

function resolveInstalledPi(): string {
	const configured = process.env.PI_SAFETY_PI_BIN
	if (configured) {
		if (!path.isAbsolute(configured)) throw new Error("PI_SAFETY_PI_BIN must be absolute")
		fs.accessSync(configured, fs.constants.X_OK)
		return configured
	}
	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!directory || directory.includes(path.join("node_modules", ".bin"))) continue
		const candidate = path.join(directory, "pi")
		if (!fs.existsSync(candidate)) continue
		const stat = fs.statSync(candidate)
		if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate
	}
	throw new Error("an installed pi executable is not available on PATH")
}

function wbDaemonPids(): ReadonlySet<number> {
	const found = spawnSync("/usr/bin/pgrep", ["-f", "wb __daemon"], { encoding: "utf8" })
	if (found.status !== 0 && found.status !== 1) throw new Error(`pgrep failed: ${found.stderr}`)
	return new Set(
		found.stdout
			.split("\n")
			.filter((line) => /^\d+$/.test(line))
			.map(Number),
	)
}

function stopNewWbDaemons(previous: ReadonlySet<number>): void {
	for (const pid of wbDaemonPids()) {
		if (!previous.has(pid)) process.kill(pid, "SIGTERM")
	}
}

function runHeadlessPi(
	fixture: HeadlessFixture,
	responses: readonly unknown[],
	options: {
		readonly persistSession?: boolean
		readonly path?: string
		readonly environment?: Readonly<Record<string, string>>
	} = {},
) {
	const piExecutable = resolveInstalledPi()
	const extensionDirectory = path.dirname(fileURLToPath(import.meta.url))
	const script = path.join(fixture.root, "script.json")
	fs.writeFileSync(script, JSON.stringify(responses), { mode: 0o600 })
	const result = spawnSync(
		piExecutable,
		[
			"--mode",
			"json",
			"--print",
			...(options.persistSession ? [] : ["--no-session"]),
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-approve",
			"--offline",
			"--tools",
			"read,write,edit,bash",
			"--extension",
			path.join(extensionDirectory, "index.ts"),
			"--extension",
			path.join(extensionDirectory, "headless-scripted-provider.ts"),
			"--provider",
			"pi-safety-scripted",
			"--model",
			"deterministic",
			"run the scripted test",
		],
		{
			cwd: fixture.workspace,
			env: {
				PATH: options.path ?? process.env.PATH,
				LANG: "en_US.UTF-8",
				HOME: fixture.home,
				CFFIXED_USER_HOME: fixture.home,
				TMPDIR: fixture.temp,
				XDG_STATE_HOME: fixture.stateHome,
				XDG_CONFIG_HOME: fixture.configHome,
				XDG_CACHE_HOME: fixture.cacheHome,
				PI_CODING_AGENT_DIR: fixture.piConfig,
				PI_SAFETY_TEST_SCRIPT: script,
				PI_OFFLINE: "1",
				...options.environment,
			},
			encoding: "utf8",
			timeout: 30_000,
			maxBuffer: 4 * 1024 * 1024,
		},
	)
	assert.equal(result.error, undefined)
	assert.equal(result.signal, null)
	assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)
	return result.stdout
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
}

test("headless Pi blocks denied calls before execution or checkpoint creation", () => {
	withTestTempDirectory("headless-pi-denied-", (root) => {
		const fixture = createFixture(root)
		const outside = path.join(root, "outside.txt")
		const events = runHeadlessPi(fixture, [
			{ kind: "tool", id: "denied-1", name: "write", arguments: { path: outside, content: "forbidden" } },
			{ kind: "text", text: "done" },
		])

		assert.equal(fs.existsSync(outside), false)
		assert.equal(fs.existsSync(path.join(fixture.stateHome, "pi-safety", "snapshots")), false)
		const toolEnds = events.filter((event) => event.type === "tool_execution_end")
		assert.equal(toolEnds.length, 1)
		assert.equal(toolEnds[0].toolName, "write")
		assert.equal(toolEnds[0].isError, true)
		assert.match(JSON.stringify(toolEnds[0].result), /pi-safety: blocked write: write access denied/)
	})
})

test("headless Pi blocks an unapproved remote effect without executing even a fixture Git", () => {
	withTestTempDirectory("headless-pi-shell-leash-", (root) => {
		const fixture = createFixture(root)
		const fixtureBin = path.join(root, "fixture-bin")
		const marker = path.join(root, "fixture-git-executed")
		fs.mkdirSync(fixtureBin)
		const fakeGit = writeShellLeashFixtureExecutable(
			fixtureBin,
			"git",
			"blocked-git",
			`printf executed > '${marker}'\n`,
		)
		const events = runHeadlessPi(fixture, [
			{ kind: "tool", id: "remote-effect-1", name: "bash", arguments: { command: `'${fakeGit}' push origin main` } },
			{ kind: "text", text: "done" },
		])

		assert.equal(fs.existsSync(marker), false)
		assert.equal(fs.existsSync(path.join(fixture.stateHome, "pi-safety", "snapshots")), false)
		const toolEnd = events.find((event) => event.type === "tool_execution_end")
		assert.equal(toolEnd?.isError, true)
		assert.match(JSON.stringify(toolEnd?.result), /shell-leash: approval requires an interactive session/)
	})
})

test("headless Pi runtime shim delegates read-only Git only to a fixture executable", () => {
	withTestTempDirectory("headless-pi-shell-leash-shim-", (root) => {
		const fixture = createFixture(root)
		const fixtureBin = path.join(root, "fixture-bin")
		const marker = path.join(fixture.temp, "fixture-git-argv")
		fs.mkdirSync(fixtureBin)
		const fakeGit = writeShellLeashFixtureExecutable(
			fixtureBin,
			"git",
			"read-only-git",
			`printf '%s\\n' "$@" > '${marker}'\n`,
		)
		const events = runHeadlessPi(
			fixture,
			[
				{
					kind: "tool",
					id: "read-only-git-1",
					name: "bash",
					arguments: { command: "git status --short" },
				},
				{ kind: "text", text: "done" },
			],
			{
				path: `${fixtureBin}${path.delimiter}${process.env.PATH ?? ""}`,
				environment: { SHELL_LEASH_GIT_EXECUTABLE: fakeGit, SHELL_LEASH_TEST_NONCE: "read-only-git" },
			},
		)

		assert.equal(fs.existsSync(marker), true, JSON.stringify(events))
		assert.equal(fs.readFileSync(marker, "utf8"), "status\n--short\n")
		const toolEnd = events.find((event) => event.type === "tool_execution_end")
		assert.equal(toolEnd?.isError, false)
	})
})

test("headless Pi runtime shim rejects a dynamically resolved mutation before the fixture Git runs", () => {
	withTestTempDirectory("headless-pi-shell-leash-dynamic-", (root) => {
		const fixture = createFixture(root)
		const fixtureBin = path.join(root, "fixture-bin")
		const marker = path.join(fixture.temp, "fixture-git-executed")
		fs.mkdirSync(fixtureBin)
		const fakeGit = writeShellLeashFixtureExecutable(
			fixtureBin,
			"git",
			"dynamic-git",
			`printf executed > '${marker}'\n`,
		)
		const events = runHeadlessPi(
			fixture,
			[
				{
					kind: "tool",
					id: "dynamic-git-1",
					name: "bash",
					arguments: { command: 'tool=git; "$tool" push --force origin main' },
				},
				{ kind: "text", text: "done" },
			],
			{
				path: `${fixtureBin}${path.delimiter}${process.env.PATH ?? ""}`,
				environment: { SHELL_LEASH_GIT_EXECUTABLE: fakeGit, SHELL_LEASH_TEST_NONCE: "dynamic-git" },
			},
		)

		assert.equal(fs.existsSync(marker), false)
		const toolEnd = events.find((event) => event.type === "tool_execution_end")
		assert.equal(toolEnd?.isError, true)
		assert.match(JSON.stringify(toolEnd?.result), /runtime-discovered remote mutation/)
		assert.match(JSON.stringify(toolEnd?.result), /git\.push\.force/)
	})
})

test("headless Pi stores runtime unknowns as hidden custom entries after fixture delegation", () => {
	withTestTempDirectory("headless-pi-shell-leash-observation-", (root) => {
		const fixture = createFixture(root)
		const fixtureBin = path.join(root, "fixture-bin")
		const marker = path.join(fixture.temp, "fixture-git-argv")
		fs.mkdirSync(fixtureBin)
		const fakeGit = writeShellLeashFixtureExecutable(
			fixtureBin,
			"git",
			"unknown-git",
			`printf '%s\\n' "$@" > '${marker}'\n`,
		)
		const events = runHeadlessPi(
			fixture,
			[
				{
					kind: "tool",
					id: "unknown-git-1",
					name: "bash",
					arguments: { command: 'tool=git; "$tool" frobnicate remote' },
				},
				{ kind: "text", text: "done" },
			],
			{
				path: `${fixtureBin}${path.delimiter}${process.env.PATH ?? ""}`,
				environment: { SHELL_LEASH_GIT_EXECUTABLE: fakeGit, SHELL_LEASH_TEST_NONCE: "unknown-git" },
			},
		)

		assert.equal(fs.readFileSync(marker, "utf8"), "frobnicate\nremote\n")
		const customEntries = events.filter(
			(event) =>
				event.type === "entry_appended" && JSON.stringify(event).includes('"customType":"shell-leash-observation"'),
		)
		assert.ok(customEntries.some((event) => JSON.stringify(event).includes('"kind":"unknown-git"')))
		const agentEnd = events.find((event) => event.type === "agent_end")
		assert.doesNotMatch(JSON.stringify(agentEnd), /\"kind\":\"unknown-git\"/)
	})
})

test("headless Pi loads strict project-specific secret paths", () => {
	withTestTempDirectory("headless-pi-config-secret-", (root) => {
		const fixture = createFixture(root)
		fs.mkdirSync(path.join(fixture.workspace, ".pi"))
		fs.writeFileSync(
			path.join(fixture.workspace, ".pi", "pi-safety.json"),
			JSON.stringify({ version: 1, protectedPaths: ["private/token.txt"] }),
		)
		fs.mkdirSync(path.join(fixture.workspace, "private"))
		fs.writeFileSync(path.join(fixture.workspace, "private", "token.txt"), "secret")
		const events = runHeadlessPi(fixture, [
			{ kind: "tool", id: "configured-secret-1", name: "read", arguments: { path: "private/token.txt" } },
			{ kind: "text", text: "done" },
		])
		const toolEnd = events.find((event) => event.type === "tool_execution_end")
		assert.equal(toolEnd?.isError, true)
		assert.match(JSON.stringify(toolEnd?.result), /read access denied/)
	})
})

test("headless Pi preserves built-in image read results", () => {
	withTestTempDirectory("headless-pi-image-read-", (root) => {
		const fixture = createFixture(root)
		const image = path.join(fixture.workspace, "pixel.png")
		fs.writeFileSync(
			image,
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
				"base64",
			),
		)
		const events = runHeadlessPi(fixture, [
			{ kind: "tool", id: "image-1", name: "read", arguments: { path: "pixel.png" } },
			{ kind: "text", text: "done" },
		])
		const toolEnd = events.find((event) => event.type === "tool_execution_end")
		assert.equal(toolEnd?.isError, false)
		assert.match(JSON.stringify(toolEnd?.result), /image/)
		assert.match(JSON.stringify(toolEnd?.result), /image\/png/)
		assert.equal(fs.existsSync(path.join(fixture.stateHome, "pi-safety", "snapshots")), false)
	})
})

test("headless Pi preserves built-in offsets, parent creation, multi-edit, BOM, and CRLF semantics", () => {
	withTestTempDirectory("headless-pi-builtin-semantics-", (root) => {
		const fixture = createFixture(root)
		fs.writeFileSync(path.join(fixture.workspace, "lines.txt"), "one\ntwo\nthree\nfour\n")
		fs.writeFileSync(path.join(fixture.workspace, "bom-crlf.txt"), Buffer.from("\uFEFFone\r\ntwo\r\nthree\r\n"))
		const events = runHeadlessPi(fixture, [
			{
				kind: "tool",
				id: "nested-write-1",
				name: "write",
				arguments: { path: "nested/directory/file.txt", content: "created" },
			},
			{
				kind: "tool",
				id: "multi-edit-1",
				name: "edit",
				arguments: {
					path: "bom-crlf.txt",
					edits: [
						{ oldText: "one", newText: "ONE" },
						{ oldText: "three", newText: "THREE" },
					],
				},
			},
			{ kind: "tool", id: "offset-read-1", name: "read", arguments: { path: "lines.txt", offset: 2, limit: 2 } },
			{ kind: "text", text: "done" },
		])
		const toolEnds = events.filter((event) => event.type === "tool_execution_end")
		assert.equal(toolEnds.length, 3)
		assert.equal(
			toolEnds.every((event) => event.isError === false),
			true,
		)
		assert.match(JSON.stringify(toolEnds[0].result), /Successfully wrote 7 bytes/)
		assert.match(JSON.stringify(toolEnds[1].result), /Successfully replaced 2 block\(s\)/)
		assert.match(JSON.stringify(toolEnds[1].result), /firstChangedLine/)
		assert.match(JSON.stringify(toolEnds[2].result), /two\\nthree/)
		assert.match(JSON.stringify(toolEnds[2].result), /2 more lines in file\. Use offset=4 to continue/)
		assert.equal(fs.readFileSync(path.join(fixture.workspace, "nested", "directory", "file.txt"), "utf8"), "created")
		assert.deepEqual(
			fs.readFileSync(path.join(fixture.workspace, "bom-crlf.txt")),
			Buffer.from("\uFEFFONE\r\ntwo\r\nTHREE\r\n"),
		)
	})
})

test("headless Pi protects persistence configuration in built-in tools and Bash", () => {
	withTestTempDirectory("headless-pi-persistence-", (root) => {
		const fixture = createFixture(root)
		fs.mkdirSync(path.join(fixture.workspace, ".git", "hooks"), { recursive: true })
		const events = runHeadlessPi(fixture, [
			{ kind: "tool", id: "persist-1", name: "write", arguments: { path: ".mcp.json", content: "x" } },
			{
				kind: "tool",
				id: "persist-2",
				name: "bash",
				arguments: {
					command:
						"printf hook > .git/hooks/post-commit; hook=$?; printf mcp > .mcp.json; mcp=$?; echo hook:$hook mcp:$mcp",
				},
			},
			{ kind: "text", text: "done" },
		])
		const toolEnds = events.filter((event) => event.type === "tool_execution_end")
		assert.equal(toolEnds.length, 2)
		assert.equal(toolEnds[0].isError, true)
		assert.match(JSON.stringify(toolEnds[0].result), /write access denied.*\.mcp\.json/)
		assert.equal(toolEnds[1].isError, false)
		assert.match(JSON.stringify(toolEnds[1].result), /hook:[1-9][0-9]* mcp:[1-9][0-9]*/)
		assert.equal(fs.existsSync(path.join(fixture.workspace, ".git", "hooks", "post-commit")), false)
		assert.equal(fs.existsSync(path.join(fixture.workspace, ".mcp.json")), false)
	})
})

test("headless Pi guards the same macOS Unicode fallback path that built-in read selects", () => {
	withTestTempDirectory("headless-pi-fallback-", (root) => {
		const fixture = createFixture(root)
		fs.writeFileSync(path.join(fixture.workspace, "Capture d’archive.txt"), "fallback-content")
		const events = runHeadlessPi(fixture, [
			{
				kind: "tool",
				id: "fallback-1",
				name: "read",
				arguments: { path: "Capture d'archive.txt" },
			},
			{ kind: "text", text: "done" },
		])
		const toolEnd = events.find((event) => event.type === "tool_execution_end")
		assert.deepEqual(toolEnd, {
			type: "tool_execution_end",
			toolCallId: "fallback-1",
			toolName: "read",
			result: { content: [{ type: "text", text: "fallback-content" }] },
			isError: false,
		})
		assert.equal(fs.existsSync(path.join(fixture.stateHome, "pi-safety", "snapshots")), false)
	})
})

test("headless Pi supports native wb with source-derived process-scoped permissions", () => {
	withTestTempDirectory("headless-pi-wb-", (root) => {
		const fixture = createFixture(root)
		const page = path.join(fixture.workspace, "page.html")
		fs.writeFileSync(
			page,
			'<html><body><input id="name"><button onclick="document.body.dataset.clicked=\'yes\'">Go</button></body></html>',
		)
		const existingWbDaemons = wbDaemonPids()
		try {
			const events = runHeadlessPi(fixture, [
				{
					kind: "tool",
					id: "wb-1",
					name: "bash",
					arguments: {
						command: [
							`opened=$(wb ${JSON.stringify(`file://${page}`)})`,
							`id=$(printf '%s' "$opened" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["browser"])')`,
							`page=$(wb page "$id" --action-details)`,
							`input=$(printf '%s' "$page" | /usr/bin/python3 -c 'import json,sys; print(next(a["id"] for a in json.load(sys.stdin)["actions"] if a["kind"] == "fill"))')`,
							`wb type "$id" "$input" typed-natively --backend native`,
							`page=$(wb page "$id" --action-details)`,
							`button=$(printf '%s' "$page" | /usr/bin/python3 -c 'import json,sys; print(next(a["id"] for a in json.load(sys.stdin)["actions"] if a["kind"] == "button"))')`,
							`wb click "$id" "$button"`,
							`wb eval "$id" --body 'return JSON.stringify({value: document.querySelector("#name").value, clicked: document.body.dataset.clicked})'`,
						].join(" && "),
					},
				},
				{ kind: "text", text: "done" },
			])
			const toolEnd = events.find((event) => event.type === "tool_execution_end")
			assert.equal(toolEnd?.toolName, "bash")
			assert.equal(toolEnd?.isError, false, JSON.stringify(toolEnd?.result))
			const serializedResult = JSON.stringify(toolEnd?.result)
			assert.match(serializedResult, /typed-natively/)
			assert.match(serializedResult, /clicked/)
			assert.match(serializedResult, /yes/)
			assert.doesNotMatch(serializedResult, /stepSQLStatement/)
			assert.equal(serializedResult.includes(os.homedir()), false)
			assert.equal(fs.existsSync(path.join(fixture.workspace, ".wb", "environment.json")), true)
			assert.equal(fs.existsSync(path.join(fixture.home, "Library", "Caches", "wb", "Cache.db")), true)
		} finally {
			stopNewWbDaemons(existingWbDaemons)
		}
	})
})

test("native wb cannot attach to an unsandboxed daemon on an alternate socket", () => {
	withTestTempDirectory("headless-pi-wb-alt-", (root) => {
		withPrivateTmpDirectory("pi-safety-wb-alt-", (shortRoot) => {
			const fixture = createFixture(root)
			const page = path.join(fixture.workspace, "page.html")
			const alternateSocket = path.join(shortRoot, "alternate.sock")
			fs.writeFileSync(page, "<html><body>Alternate daemon</body></html>")
			const wb = Bun.which("wb")
			if (!wb) throw new Error("wb executable is not available on PATH")
			const existingWbDaemons = wbDaemonPids()
			try {
				const started = spawnSync(wb, [`file://${page}`], {
					cwd: fixture.workspace,
					env: {
						...process.env,
						HOME: fixture.home,
						CFFIXED_USER_HOME: fixture.home,
						WB_SOCKET: alternateSocket,
					},
					encoding: "utf8",
					timeout: 30_000,
				})
				assert.equal(started.status, 0, started.stderr)
				const events = runHeadlessPi(fixture, [
					{
						kind: "tool",
						id: "wb-alt-1",
						name: "bash",
						arguments: {
							command: `WB_SOCKET=${JSON.stringify(alternateSocket)} wb ${JSON.stringify(`file://${page}`)}`,
							timeout: 3,
						},
					},
					{ kind: "text", text: "done" },
				])
				const toolEnd = events.find((event) => event.type === "tool_execution_end")
				assert.equal(toolEnd?.toolName, "bash")
				assert.equal(toolEnd?.isError, true)
				assert.doesNotMatch(JSON.stringify(toolEnd?.result), /browser/)
			} finally {
				stopNewWbDaemons(existingWbDaemons)
			}
		})
	})
}, 15_000)

test("headless Pi Seatbelt denies Bash writes outside workspace", () => {
	withTestTempDirectory("headless-pi-bash-denied-", (root) => {
		const fixture = createFixture(root)
		const forbidden = path.join(fixture.home, "forbidden.txt")
		const events = runHeadlessPi(fixture, [
			{
				kind: "tool",
				id: "bash-denied-1",
				name: "bash",
				arguments: { command: `printf forbidden > ${JSON.stringify(forbidden)}` },
			},
			{ kind: "text", text: "done" },
		])
		assert.equal(fs.existsSync(forbidden), false)
		const toolEnd = events.find((event) => event.type === "tool_execution_end")
		assert.equal(toolEnd?.toolName, "bash")
		assert.match(JSON.stringify(toolEnd?.result), /Operation not permitted/)
		assert.equal(fs.existsSync(path.join(fixture.stateHome, "pi-safety", "snapshots")), true)
	})
})

test("sandboxed snapshot CLI cannot mutate history or read protected content", () => {
	withTestTempDirectory("headless-pi-snapshot-cli-", (root) => {
		const fixture = createFixture(root)
		fs.writeFileSync(path.join(fixture.workspace, ".env"), "TOP_SECRET_VALUE")
		fs.writeFileSync(path.join(fixture.workspace, "ordinary.txt"), "before")
		const snapshotCli = path.join(path.dirname(fileURLToPath(import.meta.url)), "pi-snapshot.ts")
		const command = [
			"printf after > ordinary.txt",
			`${JSON.stringify(snapshotCli)} create`,
			"create_status=$?",
			`id=$(${JSON.stringify(snapshotCli)} list | tail -n +2 | head -n 1 | awk '{print $1}')`,
			`${JSON.stringify(snapshotCli)} show "$id" .env`,
			"show_status=$?",
			`${JSON.stringify(snapshotCli)} restore "$id" --apply`,
			"restore_status=$?",
			'test "$(cat ordinary.txt)" = after',
			"atomic_status=$?",
			`${JSON.stringify(snapshotCli)} diff "$id" -- ordinary.txt >/dev/null`,
			"diff_status=$?",
			`${JSON.stringify(snapshotCli)} restore "$id" --apply -- ordinary.txt`,
			"selected_status=$?",
			"echo create:$create_status show:$show_status restore:$restore_status atomic:$atomic_status diff:$diff_status selected:$selected_status",
			"test $create_status -ne 0 -a $show_status -ne 0 -a $restore_status -ne 0 -a $atomic_status -eq 0 -a $diff_status -eq 0 -a $selected_status -eq 0",
		].join("; ")
		const events = runHeadlessPi(fixture, [
			{ kind: "tool", id: "snapshot-cli-1", name: "bash", arguments: { command } },
			{ kind: "text", text: "done" },
		])
		const toolEnd = events.find((event) => event.type === "tool_execution_end")
		const output = JSON.stringify(toolEnd?.result)
		assert.equal(toolEnd?.isError, false, output)
		assert.match(output, /create:[1-9][0-9]* show:[1-9][0-9]* restore:[1-9][0-9]* atomic:0 diff:0 selected:0/)
		assert.equal(fs.readFileSync(path.join(fixture.workspace, "ordinary.txt"), "utf8"), "before")
		assert.doesNotMatch(output, /TOP_SECRET_VALUE/)
		const snapshotRoot = path.join(fixture.stateHome, "pi-safety", "snapshots")
		const project = fs.readdirSync(snapshotRoot)[0]
		const snapshots = fs.readdirSync(path.join(snapshotRoot, project)).filter((name) => !name.startsWith("."))
		assert.equal(snapshots.length, 1)
	})
})

test("persists one non-context checkpoint marker for each mutating agent run", () => {
	withTestTempDirectory("headless-pi-checkpoint-entry-", (root) => {
		const fixture = createFixture(root)
		runHeadlessPi(
			fixture,
			[
				{ kind: "tool", id: "write-1", name: "write", arguments: { path: "first.txt", content: "first" } },
				{ kind: "tool", id: "write-2", name: "write", arguments: { path: "second.txt", content: "second" } },
				{ kind: "text", text: "done" },
			],
			{ persistSession: true },
		)

		const sessionRoot = path.join(fixture.piConfig, "sessions")
		const sessionFiles = fs
			.readdirSync(sessionRoot, { recursive: true, encoding: "utf8" })
			.filter((relativePath) => relativePath.endsWith(".jsonl"))
			.map((relativePath) => path.join(sessionRoot, relativePath))
		assert.equal(sessionFiles.length, 1)
		const entries = fs
			.readFileSync(sessionFiles[0], "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>)
		const markers = entries.filter((entry) => entry.type === "custom" && entry.customType === "pi-safety-checkpoint")
		assert.equal(markers.length, 1)
		assert.equal(
			entries.some((entry) => entry.type === "custom_message" && entry.customType === "pi-safety-checkpoint"),
			false,
		)
		const marker = markers[0].data as Record<string, unknown>
		assert.equal(marker.version, 1)
		assert.match(String(marker.snapshotId), /^\d{17}-[0-9a-f]{16}$/)
		assert.equal(typeof marker.createdAt, "string")
		const snapshotRoot = path.join(fixture.stateHome, "pi-safety", "snapshots")
		const project = fs.readdirSync(snapshotRoot)[0]
		const snapshotDirectory = path.join(snapshotRoot, project, String(marker.snapshotId))
		assert.equal(fs.existsSync(snapshotDirectory), true)
		const sessionHeader = entries.find((entry) => entry.type === "session")
		const manifest = JSON.parse(fs.readFileSync(path.join(snapshotDirectory, "manifest.json"), "utf8"))
		assert.deepEqual(manifest.origin, { kind: "pi-session", sessionId: sessionHeader?.id })
	})
})

test("child Pi processes launched by Bash inherit the active Seatbelt", () => {
	withTestTempDirectory("headless-pi-child-", (root) => {
		const fixture = createFixture(root)
		const outside = path.join(root, "child-escape.txt")
		const childScript = path.join(fixture.workspace, "child-script.json")
		fs.writeFileSync(
			childScript,
			JSON.stringify([
				{
					kind: "tool",
					id: "child-bash-1",
					name: "bash",
					arguments: { command: `printf escaped > ${JSON.stringify(outside)}` },
				},
				{ kind: "text", text: "child done" },
			]),
		)
		const extensionDirectory = path.dirname(fileURLToPath(import.meta.url))
		const childArgs = [
			"--mode",
			"json",
			"--print",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-approve",
			"--offline",
			"--tools",
			"bash",
			"--extension",
			path.join(extensionDirectory, "headless-scripted-provider.ts"),
			"--provider",
			"pi-safety-scripted",
			"--model",
			"deterministic",
			"run child script",
		]
		const command = `PI_SAFETY_TEST_SCRIPT=${JSON.stringify(childScript)} ${JSON.stringify(resolveInstalledPi())} ${childArgs.map((argument) => JSON.stringify(argument)).join(" ")}`
		const events = runHeadlessPi(fixture, [
			{ kind: "tool", id: "parent-bash-1", name: "bash", arguments: { command } },
			{ kind: "text", text: "done" },
		])
		const toolEnd = events.find((event) => event.type === "tool_execution_end")
		assert.equal(toolEnd?.isError, false, JSON.stringify(toolEnd?.result))
		assert.match(JSON.stringify(toolEnd?.result), /Operation not permitted/)
		assert.equal(fs.existsSync(outside), false)
	})
})

test("headless Pi runs Bash inside Seatbelt after checkpointing", () => {
	withTestTempDirectory("headless-pi-bash-", (root) => {
		const fixture = createFixture(root)
		fs.writeFileSync(path.join(fixture.workspace, "existing.txt"), "before-bash")
		const events = runHeadlessPi(fixture, [
			{
				kind: "tool",
				id: "bash-1",
				name: "bash",
				arguments: { command: "printf sandboxed > bash-created.txt && node --version" },
			},
			{ kind: "text", text: "done" },
		])
		assert.equal(fs.readFileSync(path.join(fixture.workspace, "bash-created.txt"), "utf8"), "sandboxed")
		const toolEnd = events.find((event) => event.type === "tool_execution_end")
		assert.equal(toolEnd?.toolName, "bash")
		assert.equal(toolEnd?.isError, false)
		assert.match(JSON.stringify(toolEnd?.result), /v\d+\.\d+\.\d+/)
		const snapshotRoot = path.join(fixture.stateHome, "pi-safety", "snapshots")
		const project = fs.readdirSync(snapshotRoot)[0]
		const snapshot = fs.readdirSync(path.join(snapshotRoot, project)).find((name) => !name.startsWith("."))
		if (!snapshot) throw new Error("headless Bash checkpoint was not published")
		assert.equal(
			fs.readFileSync(path.join(snapshotRoot, project, snapshot, "tree", "existing.txt"), "utf8"),
			"before-bash",
		)
	})
})

test("headless Pi preserves Bash errors, timeout, streaming, truncation, and full output", () => {
	withTestTempDirectory("headless-pi-bash-parity-", (root) => {
		const fixture = createFixture(root)
		const events = runHeadlessPi(fixture, [
			{
				kind: "tool",
				id: "bash-error-1",
				name: "bash",
				arguments: { command: "printf stdout; printf stderr >&2; exit 7" },
			},
			{
				kind: "tool",
				id: "bash-timeout-1",
				name: "bash",
				arguments: { command: "sleep 2", timeout: 0.05 },
			},
			{
				kind: "tool",
				id: "bash-truncation-1",
				name: "bash",
				arguments: {
					command: "node -e 'for (let i = 0; i < 2500; i++) console.log(i)'",
				},
			},
			{ kind: "text", text: "done" },
		])
		const toolEnds = events.filter((event) => event.type === "tool_execution_end")
		assert.equal(toolEnds.length, 3)
		assert.equal(toolEnds[0].isError, true)
		assert.match(JSON.stringify(toolEnds[0].result), /stdoutstderr/)
		assert.match(JSON.stringify(toolEnds[0].result), /exited with code 7/)
		assert.equal(toolEnds[1].isError, true)
		assert.match(JSON.stringify(toolEnds[1].result), /timed out after 0\.05 seconds/)
		assert.equal(toolEnds[2].isError, false)
		const finalResult = toolEnds[2].result as {
			details?: { truncation?: { truncated?: boolean }; fullOutputPath?: string }
		}
		assert.equal(finalResult.details?.truncation?.truncated, true)
		const fullOutputPath = finalResult.details?.fullOutputPath
		assert.equal(typeof fullOutputPath, "string")
		if (typeof fullOutputPath !== "string") return
		assert.equal(path.dirname(fullOutputPath), fixture.temp)
		const fullOutput = fs.readFileSync(fullOutputPath, "utf8")
		assert.match(fullOutput, /^0\n1\n/)
		assert.match(fullOutput, /2498\n2499\n$/)
		assert.equal(
			events.some((event) => event.type === "tool_execution_update"),
			true,
		)
	})
})

test("headless Pi preserves built-in write, edit, and read while creating one checkpoint", () => {
	withTestTempDirectory("headless-pi-builtins-", (root) => {
		const fixture = createFixture(root)
		fs.writeFileSync(path.join(fixture.workspace, "existing.txt"), "before")
		const events = runHeadlessPi(fixture, [
			{ kind: "tool", id: "write-1", name: "write", arguments: { path: "created.txt", content: "alpha" } },
			{
				kind: "tool",
				id: "edit-1",
				name: "edit",
				arguments: { path: "created.txt", oldText: "alpha", newText: "beta" },
			},
			{ kind: "tool", id: "read-1", name: "read", arguments: { path: "created.txt" } },
			{ kind: "text", text: "done" },
		])

		const toolEnds = events.filter((event) => event.type === "tool_execution_end")
		assert.deepEqual(toolEnds, [
			{
				type: "tool_execution_end",
				toolCallId: "write-1",
				toolName: "write",
				result: { content: [{ type: "text", text: "Successfully wrote 5 bytes to created.txt" }] },
				isError: false,
			},
			{
				type: "tool_execution_end",
				toolCallId: "edit-1",
				toolName: "edit",
				result: {
					content: [{ type: "text", text: "Successfully replaced 1 block(s) in created.txt." }],
					details: {
						diff: "-1 alpha\n+1 beta",
						patch:
							"--- created.txt\n+++ created.txt\n@@ -1,1 +1,1 @@\n-alpha\n\\ No newline at end of file\n+beta\n\\ No newline at end of file\n",
						firstChangedLine: 1,
					},
				},
				isError: false,
			},
			{
				type: "tool_execution_end",
				toolCallId: "read-1",
				toolName: "read",
				result: { content: [{ type: "text", text: "beta" }] },
				isError: false,
			},
		])
		assert.equal(fs.readFileSync(path.join(fixture.workspace, "created.txt"), "utf8"), "beta")
		const snapshotRoot = path.join(fixture.stateHome, "pi-safety", "snapshots")
		const projects = fs.readdirSync(snapshotRoot)
		assert.equal(projects.length, 1)
		const snapshots = fs.readdirSync(path.join(snapshotRoot, projects[0])).filter((name) => !name.startsWith("."))
		assert.equal(snapshots.length, 1)
		assert.equal(
			fs.readFileSync(path.join(snapshotRoot, projects[0], snapshots[0], "tree", "existing.txt"), "utf8"),
			"before",
		)
	})
})

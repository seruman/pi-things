import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { testDirectory } from "../session-messages/fixtures/sdk"

function fixture() {
	const root = testDirectory()
	const upstream = join(root, "upstream")
	const destination = join(root, "extensions", "poteto", "vendor", "pstack")

	function write(path: string, content: string) {
		const file = join(root, path)
		mkdirSync(dirname(file), { recursive: true })
		writeFileSync(file, content)
	}

	for (const path of ["skills", "tools", "upstream/pstack/agents", "upstream/pstack/docs/guide"]) {
		mkdirSync(join(root, path), { recursive: true })
	}

	cpSync(resolve("tools/sync-pstack.ts"), join(root, "tools", "sync-pstack.ts"))
	write("extensions/poteto/vendor/pstack/ADAPTER.md", "Local adapter: keep me\n")
	write("upstream/pstack/README.md", "# Fixture pstack\n")
	write("upstream/pstack/LICENSE", "Test license\n")
	write("upstream/cursor-team-kit/LICENSE", "Test license\n")
	write(
		"upstream/cursor-team-kit/skills/deslop/SKILL.md",
		"---\nname: deslop\ndescription: Clean code\n---\n# Deslop\n",
	)

	for (const name of ["unslop", "blast-radius", "how", "typescript-best-practices", "sample"]) {
		write(
			`upstream/pstack/skills/${name}/SKILL.md`,
			`---\nname: ${name}\ndescription: Test skill\ndisable-model-invocation: true\n---\n# ${name}\n\nUse the Task tool.\n`,
		)
	}

	execFileSync("git", ["init", "--quiet", upstream])
	execFileSync("git", ["add", "."], { cwd: upstream })
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--quiet",
			"-m",
			"Fixture",
		],
		{ cwd: upstream },
	)

	return {
		root,
		destination,
		write,
		sync: () =>
			Bun.spawnSync({
				cmd: [process.execPath, join(root, "tools", "sync-pstack.ts"), "--source", upstream],
				cwd: root,
			}),
	}
}

test("sync vendors into the extension, preserves the adapter, and is repeatable", () => {
	const h = fixture()
	const result = h.sync()
	expect(result.exitCode).toBe(0)
	expect(existsSync(join(h.root, "skills", "pstack"))).toBe(false)
	expect(readFileSync(join(h.destination, "ADAPTER.md"), "utf8")).toBe("Local adapter: keep me\n")
	const skill = join(h.destination, "skills", "how", "SKILL.md")
	const first = readFileSync(skill, "utf8")
	expect(first).toContain("../../ADAPTER.md")
	expect(first).not.toContain("disable-model-invocation")
	expect(readFileSync(join(h.destination, "skills", "sample", "SKILL.md"), "utf8")).toContain(
		"disable-model-invocation: true",
	)
	expect(existsSync(join(h.destination, "UPSTREAM.md"))).toBe(true)
	expect(h.sync().exitCode).toBe(0)
	expect(readFileSync(skill, "utf8")).toBe(first)
	expect(readFileSync(join(h.destination, "ADAPTER.md"), "utf8")).toBe("Local adapter: keep me\n")
})

test("sync still detects collisions between the gated pack and ordinary skills", () => {
	const h = fixture()
	h.write("skills/sample/SKILL.md", "---\nname: sample\ndescription: Existing skill\n---\n# Sample\n")
	const result = h.sync()
	expect(result.exitCode).toBe(1)
	const error = result.stderr.toString()
	expect(error).toContain("skill name collision: sample")
	expect(error).toContain("skills/sample/SKILL.md")
	expect(error).toContain("extensions/poteto/vendor/pstack/skills/sample/SKILL.md")
})

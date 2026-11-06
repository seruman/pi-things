#!/usr/bin/env bun
// Vendors pstack from cursor/plugins into skills/pstack. Rerun to update, then review the diff.
// Vendored files are regenerated on every run. Pi-specific guidance lives in skills/pstack/ADAPTER.md.

import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, posix, relative } from "node:path"
import { parseArgs } from "node:util"

const REPO = "https://github.com/cursor/plugins"

const ROOT = join(import.meta.dir, "..")

const SKILLS_ROOT = join(ROOT, "skills")

const DEST = join(SKILLS_ROOT, "pstack")

const LOCAL_FILES = new Set(["ADAPTER.md"])

const EXCLUDED_SKILLS = {
	"setup-pstack": "every role runs on the parent model, so there is nothing to configure",
	"make-bot-ui": "drives Cursor Grok Bot webhooks",
	"ketchup-video": "renders a video summary; /ketchup covers the need",
} as const satisfies Record<string, string>

const AUTO_INVOKED = ["unslop", "blast-radius", "how", "typescript-best-practices"]

const EXTRA_SKILLS = [{ source: "cursor-team-kit/skills/deslop", name: "deslop" }]

const SKIPPED_NAMES = new Set(["node_modules", ".DS_Store", "images"])

const SKIPPED_PATHS = new Set(["statechart/scripts/test"])

const ADAPTER_LINE =
	"In pi, read [the pi adapter](../../ADAPTER.md) once per session before you follow this skill. " +
	"It maps the Cursor names in pstack skills to pi."

const CURSOR_TERMS =
	/`Task`|\bTask (tool|subagent|call)|AskQuestion|todo ?list|generalPurpose|poteto-agent|comment-sicko|readonly|environment: "|cloud_base_branch|run_in_background|`resume`|file_attachments|\bclaude-[a-z]+-\d|\bgrok-\d|\bgpt-\d|inherit-parent|pstack-models|\.cursor|agent-transcripts|Bugbot|Automation|[Cc]loud agent|\bOrigin\b|control-(ui|cli)|deslop|create-skill|\bmise\b|Cursor/

function routesToOtherSkills(text: string, skills: string[]): boolean {
	const names = skills.join("|")

	return new RegExp(`the \\*\\*(${names})\\*\\* (skill|principle)|\`/(${names})\``).test(text)
}

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		if (SKIPPED_NAMES.has(name)) return []
		const path = join(dir, name)

		return statSync(path).isDirectory() ? walk(path) : [path]
	})
}

function checkout(ref: string, source: string | undefined): string {
	if (source) return source
	const dir = join(mkdtempSync(join(tmpdir(), "pstack-sync-")), "plugins")
	execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", ref, `${REPO}.git`, dir], { stdio: "inherit" })

	return dir
}

function copyTree(from: string, to: string, skip: (rel: string) => boolean = () => false): void {
	cpSync(from, to, {
		recursive: true,
		filter: (path) => !SKIPPED_NAMES.has(basename(path)) && !skip(relative(from, path)),
	})
}

// Links to upstream files left out of this copy point at GitHub, as upstream's Claude Code tree does.
function linkMissingToGitHub(commit: string): void {
	for (const path of walk(DEST).filter((file) => file.endsWith(".md"))) {
		const text = readFileSync(path, "utf8")

		const next = text.replace(/\]\(([^)\s]+)\)/g, (link, href: string) => {
			const target = href.replace(/[#?].*/, "")

			if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || existsSync(join(dirname(path), target))) return link
			const upstream = posix.normalize(posix.join(relative(DEST, dirname(path)), target))

			if (upstream.startsWith("..")) return link

			return `](${REPO}/blob/${commit}/pstack/${upstream}${href.slice(target.length)})`
		})

		if (next !== text) writeFileSync(path, next)
	}
}

function frontmatter(text: string): string {
	return text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ""
}

function injectAdapterLine(text: string): string {
	if (/^# /m.test(text)) return text.replace(/^(# .*)\n+/m, `$1\n\n${ADAPTER_LINE}\n\n`)

	return text.replace(/^(---\n[\s\S]*?\n---\n)\n*/, `$1\n${ADAPTER_LINE}\n\n`)
}

function enableModelInvocation(skill: string, text: string): string {
	const next = text.replace(/^disable-model-invocation: true\n/m, "")

	if (next === text) throw new Error(`${skill} is not manual-only upstream; review AUTO_INVOKED`)

	return next
}

function skillNames(dir: string): Map<string, string[]> {
	const names = new Map<string, string[]>()

	for (const path of walk(dir).filter((path) => basename(path) === "SKILL.md")) {
		const name = frontmatter(readFileSync(path, "utf8"))
			.match(/^name:(.*)$/m)?.[1]
			?.trim()
			.replace(/^(["'])(.*)\1$/, "$2")

		if (name) names.set(name, [...(names.get(name) ?? []), relative(ROOT, path)])
	}

	return names
}

function writeProvenance(commit: string, ref: string): void {
	const excluded = Object.entries(EXCLUDED_SKILLS)
		.map(([name, reason]) => `- \`${name}\`: ${reason}.`)
		.join("\n")

	const extras = EXTRA_SKILLS.map(({ source, name }) => `- \`skills/${name}\` from \`${source}\``).join("\n")
	writeFileSync(
		join(DEST, "UPSTREAM.md"),
		`# pstack provenance

Generated by \`tools/sync-pstack.ts\`. Do not edit vendored files by hand. Change \`ADAPTER.md\` or the sync script, then run \`bun run sync:pstack\` and review the diff.

- Source: ${REPO} (\`pstack/\`), ref \`${ref}\`
- Commit: \`${commit}\`
- Licenses: \`LICENSE\` (pstack, MIT, Lauren Tan) and \`LICENSE-cursor-team-kit\` (MIT, Cursor).

## Extra skills

${extras}

## Excluded skills

${excluded}

Also excluded: \`automations/\`, \`assets/\`, \`docs/harness/\`, guide images, and \`statechart/scripts/test\`.

## Local changes

- Every SKILL.md that uses Cursor names gets one line under its title pointing at \`ADAPTER.md\`.
- Relative links to upstream files left out of this copy point at GitHub at the synced commit.
- Model invocation is enabled for: ${AUTO_INVOKED.map((name) => `\`${name}\``).join(", ")}. Every other skill stays manual-only (\`/skill:<name>\`).
`,
	)
}

function main(): void {
	const { values } = parseArgs({
		options: { ref: { type: "string", default: "main" }, source: { type: "string" } },
	})

	const ref = values.ref ?? "main"
	const repo = checkout(ref, values.source)
	const commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
	const pstack = join(repo, "pstack")

	for (const name of Object.keys(EXCLUDED_SKILLS)) {
		if (!existsSync(join(pstack, "skills", name))) console.warn(`excluded skill ${name} no longer exists upstream`)
	}

	for (const entry of existsSync(DEST) ? readdirSync(DEST) : []) {
		if (!LOCAL_FILES.has(entry)) rmSync(join(DEST, entry), { recursive: true, force: true })
	}

	copyTree(join(pstack, "skills"), join(DEST, "skills"), (rel) => {
		const [skill] = rel.split("/")

		return (skill !== undefined && Object.hasOwn(EXCLUDED_SKILLS, skill)) || SKIPPED_PATHS.has(rel)
	})

	for (const { source, name } of EXTRA_SKILLS) copyTree(join(repo, source), join(DEST, "skills", name))
	copyTree(join(pstack, "agents"), join(DEST, "agents"))
	copyTree(join(pstack, "docs", "guide"), join(DEST, "docs", "guide"))
	cpSync(join(pstack, "README.md"), join(DEST, "README.md"))
	cpSync(join(pstack, "LICENSE"), join(DEST, "LICENSE"))
	cpSync(join(repo, "cursor-team-kit", "LICENSE"), join(DEST, "LICENSE-cursor-team-kit"))

	const skillsDir = join(DEST, "skills")
	const skills = readdirSync(skillsDir)
	let wrapped = 0

	for (const skill of skills) {
		const path = join(skillsDir, skill, "SKILL.md")

		if (!existsSync(path)) continue

		const usesCursorNames = walk(join(skillsDir, skill))
			.filter((file) => file.endsWith(".md"))
			.some((file) => {
				const text = readFileSync(file, "utf8")

				return CURSOR_TERMS.test(text) || routesToOtherSkills(text, skills)
			})

		let text = readFileSync(path, "utf8")

		if (usesCursorNames) {
			text = injectAdapterLine(text)
			wrapped++
		}

		if (AUTO_INVOKED.includes(skill)) text = enableModelInvocation(skill, text)
		writeFileSync(path, text)
	}

	const collisions = [...skillNames(SKILLS_ROOT)].filter(([, paths]) => paths.length > 1)

	for (const [name, paths] of collisions) console.error(`skill name collision: ${name} in ${paths.join(", ")}`)

	linkMissingToGitHub(commit)
	writeProvenance(commit, ref)
	console.log(
		`pstack ${commit.slice(0, 12)}: ${readdirSync(skillsDir).length} skills, ${wrapped} with the adapter line`,
	)

	if (collisions.length > 0) process.exit(1)
}

main()

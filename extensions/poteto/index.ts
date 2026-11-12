import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
	getAgentDir,
	parseFrontmatter,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { z } from "zod"

const STATE_TYPE = "poteto-mode"

const stateSchema = z.object({ enabled: z.boolean() })

const vendoredPstack = fileURLToPath(new URL("./vendor/pstack/", import.meta.url))

export function createPotetoExtension(options: { agentDir?: string; pstackDir?: string } = {}) {
	return (pi: ExtensionAPI) => {
		const defaultsDir = join(options.agentDir ?? getAgentDir(), "poteto", "defaults")
		const pstackDir = options.pstackDir ?? vendoredPstack
		const skillFile = join(pstackDir, "skills", "poteto-mode", "SKILL.md")
		const adapterFile = join(pstackDir, "ADAPTER.md")
		const isChild = Boolean(process.env.PI_SUBAGENT_RUN_DIR) || process.env.PI_IS_SUBAGENT === "1"
		let enabled = false

		function defaultFile(folder: string) {
			return join(defaultsDir, `${createHash("sha256").update(folder).digest("hex")}.json`)
		}

		function folderDefault(cwd: string): boolean {
			for (let folder = resolve(cwd); ; folder = dirname(folder)) {
				const file = defaultFile(folder)

				if (existsSync(file)) return stateSchema.parse(JSON.parse(readFileSync(file, "utf8"))).enabled

				if (dirname(folder) === folder) return false
			}
		}

		function prompt() {
			return [
				`Poteto mode is enabled. Follow it on every task, using the pi adapter below to translate Cursor instructions.`,
				`The adapter is \`${adapterFile}\`; <pstack> is \`${pstackDir}\`.`,
				`The skill is \`${skillFile}\`. Resolve its relative paths (including playbooks/ and ../<name>/) from \`${dirname(skillFile)}\`, not the working directory.`,
				readFileSync(adapterFile, "utf8").trim(),
				parseFrontmatter(readFileSync(skillFile, "utf8")).body.trim(),
			].join("\n\n")
		}

		function status(ctx: ExtensionContext) {
			ctx.ui.setStatus("poteto", enabled ? "poteto:on" : undefined)
		}

		function reportError(ctx: ExtensionContext, message: string) {
			ctx.ui.notify(`Poteto mode: ${message}`, "error")
		}

		function restore(ctx: ExtensionContext) {
			enabled = false

			if (!isChild) {
				try {
					let choice: boolean | undefined

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue
						const state = stateSchema.safeParse(entry.data)

						if (state.success) choice = state.data.enabled
					}

					enabled = choice ?? folderDefault(ctx.cwd)

					if (enabled) prompt()
				} catch (error) {
					enabled = false
					reportError(ctx, error instanceof Error ? error.message : String(error))
				}
			}

			status(ctx)
		}

		pi.on("session_start", (_event, ctx) => restore(ctx))
		pi.on("resources_discover", () => ({ skillPaths: enabled ? [join(pstackDir, "skills")] : [] }))
		pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus("poteto", undefined))
		pi.on("before_agent_start", (event, ctx) => {
			delete event.systemPromptOptions.sections["poteto-mode"]

			if (!enabled) return

			try {
				event.systemPromptOptions.sections["poteto-mode"] = prompt()
				status(ctx)
			} catch (error) {
				ctx.ui.setStatus("poteto", "poteto:error")
				reportError(ctx, error instanceof Error ? error.message : String(error))
			}
		})

		pi.registerCommand("poteto", {
			description: "Toggle poteto mode; on/off sets this session; repo flips this folder's default",
			getArgumentCompletions(prefix) {
				const items = ["on", "off", "repo"].flatMap((value) =>
					value.startsWith(prefix.trim()) ? [{ value, label: value }] : [],
				)

				return items.length ? items : null
			},
			handler: async (args, ctx) => {
				if (isChild) {
					ctx.ui.notify("Poteto mode is controlled by the parent's brief in subagents", "warning")

					return
				}

				const arg = args.trim().toLowerCase()

				if (!["", "on", "off", "repo"].includes(arg)) {
					ctx.ui.notify("Usage: /poteto [on|off|repo]", "warning")

					return
				}

				if (!ctx.isIdle()) {
					ctx.ui.notify("Wait for the current task to finish before toggling poteto", "warning")

					return
				}

				try {
					const next = arg === "repo" ? !folderDefault(ctx.cwd) : arg === "on" || (arg === "" && !enabled)

					if (next) prompt()

					if (arg === "repo") {
						mkdirSync(defaultsDir, { recursive: true })
						writeFileSync(defaultFile(resolve(ctx.cwd)), JSON.stringify({ enabled: next }))
					}

					pi.appendEntry(STATE_TYPE, { enabled: next })
					enabled = next
					status(ctx)
					const scope = arg === "repo" ? `; default for ${resolve(ctx.cwd)} and descendants` : ""
					ctx.ui.notify(`Poteto mode ${enabled ? "on" : "off"}${scope} — reloading`, "info")
					await ctx.reload()

					return
				} catch (error) {
					reportError(ctx, error instanceof Error ? error.message : String(error))
				}
			},
		})
	}
}

export default createPotetoExtension()

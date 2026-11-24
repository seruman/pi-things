// `/mdreview <file>` and `/mdreview-last` review Markdown in mdreview, in a Rex floating layer over
// this session, and send what the review says to the agent as the next message. The command
// returns once the layer opens, so the session stays usable while the review is open.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { resolveRexSession } from "./lib/rex"

type Executor = Pick<ExtensionAPI, "exec">

type Rex = { session: string; block: string }

export type Review = {
	/** What the review shows: a file, or the agent's reply written to a temporary one. */
	document: string
	/** The document goes in on stdin, so the review names no temporary file. */
	stdin: boolean
	/** What the feedback message calls it. */
	subject: string
	/** Where mdreview writes the review. */
	output: string
	directory: string
}

/** The layer's place: [x, y, w, h] as fractions of the window. mdreview keeps its page in a
 * centred column, so a full-width layer only adds empty sides. */
const BOUNDS = [0.2, 0.06, 0.6, 0.88]

export async function rexFromEnv(env: NodeJS.ProcessEnv, pi: Executor): Promise<Rex | undefined> {
	const block = env.REX_BLOCK?.trim()

	if (env.TERM_PROGRAM !== "rex" || !block) return undefined
	const session = await resolveRexSession((command, args) => pi.exec(command, args), block)

	return { session, block }
}

/** The text of the newest assistant message on the branch that finished its turn. */
export function lastAssistantText(branch: SessionEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]

		if (entry.type !== "message" || entry.message.role !== "assistant") continue

		const text = entry.message.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n")
			.trim()

		if (text) return text
	}

	return undefined
}

/** The layer's command: mdreview in the terminal shell. */
export function reviewCommand(binary: string, review: Review): string[] {
	if (review.stdin) {
		return ["/bin/sh", "-c", 'RUNE_TERMINAL=1 exec "$0" - -o "$1" < "$2"', binary, review.output, review.document]
	}

	return ["/usr/bin/env", "RUNE_TERMINAL=1", binary, review.document, "-o", review.output]
}

/** `MDREVIEW_BIN`, else `mdreview`, which the layer's terminal finds on its PATH. */
export function binary(env: NodeJS.ProcessEnv): string {
	return env.MDREVIEW_BIN?.trim() || "mdreview"
}

/** The exit status of a command the shell or `env` couldn't find. */
const NOT_FOUND = 127

/** What `session.new_layer` takes, as far as this asks for. */
type NewLayer = {
	session_id: string
	bounds: number[]
	focus: boolean
	window_id?: string
	layout: { block: { flavor: string; label: string; options: { command: string[]; cwd: string } } }
}

export function newLayerRequest(rex: Rex, window: string | undefined, cwd: string, command: string[]): string {
	const request: NewLayer = {
		session_id: rex.session,
		bounds: BOUNDS,
		focus: true,
		layout: { block: { flavor: "com.superlogical.terminal.shell", label: "mdreview", options: { command, cwd } } },
	}

	if (window) request.window_id = window

	return JSON.stringify(request)
}

/** What the agent gets: the review mdreview wrote, under a line saying what it reviewed. */
export function feedbackMessage(subject: string, feedback: string): string {
	return `I reviewed ${subject} in mdreview. My feedback:\n\n${feedback.trim()}\n`
}

async function windowOf(pi: Executor, rex: Rex): Promise<string | undefined> {
	const inspected = await pi.exec("rex", ["session", "inspect", rex.session, "--json"])

	if (inspected.code !== 0) return undefined

	const session: { windows?: { window_id: string; layers?: { blocks?: { block_id: string }[] }[] }[] } = JSON.parse(
		inspected.stdout,
	)

	return session.windows?.find((w) => w.layers?.some((l) => l.blocks?.some((b) => b.block_id === rex.block)))?.window_id
}

async function callRex(pi: Executor, rex: Rex, method: string, request: string): Promise<string> {
	const result = await pi.exec("rex", ["api", "call", "-s", rex.session, method, request])

	if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `rex ${method} failed`)

	return result.stdout
}

async function readIfThere(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8")
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
		throw error
	}
}

export type Host = Pick<ExtensionAPI, "exec" | "sendUserMessage">

export type Session = Pick<ExtensionCommandContext, "cwd" | "hasUI" | "isIdle"> & {
	ui: Pick<ExtensionCommandContext["ui"], "notify">
}

/** Opens `review` in a floating layer and, once mdreview exits, sends its review to the agent.
 * Resolves when the layer is open, with what finishes after it closes. */
export async function open(pi: Host, ctx: Session, rex: Rex, review: Review): Promise<{ done: Promise<void> }> {
	const window = await windowOf(pi, rex)
	const request = newLayerRequest(rex, window, ctx.cwd, reviewCommand(binary(process.env), review))

	const created: { layer_id: string; block_ids: string[] } = JSON.parse(
		await callRex(pi, rex, "session.new_layer", request),
	)

	const block = created.block_ids[0]

	const done = (async () => {
		try {
			// `rex wait` returns the terminal child's exit status; the layer itself stays open.
			const waited = await pi.exec("rex", ["wait", "-s", rex.session, block])
			const feedback = await readIfThere(review.output)

			if (feedback?.trim()) {
				const message = feedbackMessage(review.subject, feedback)

				if (ctx.isIdle()) pi.sendUserMessage(message)
				else pi.sendUserMessage(message, { deliverAs: "followUp" })
			} else if (waited.code === NOT_FOUND && ctx.hasUI) {
				ctx.ui.notify(`${binary(process.env)} wasn't found in the layer's PATH; set MDREVIEW_BIN`, "error")
			} else if (waited.code !== 0 && ctx.hasUI) {
				ctx.ui.notify(`mdreview exited with status ${waited.code}, nothing sent`, "warning")
			} else if (ctx.hasUI) {
				ctx.ui.notify("Review closed, nothing sent", "info")
			}
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`mdreview: ${error instanceof Error ? error.message : String(error)}`, "error")
		} finally {
			await callRex(
				pi,
				rex,
				"session.close_layer",
				JSON.stringify({ session_id: rex.session, layer_id: created.layer_id }),
			).catch(() => undefined)
			await callRex(
				pi,
				rex,
				"session.focus_block",
				JSON.stringify({ session_id: rex.session, block_id: rex.block }),
			).catch(() => undefined)
			await rm(review.directory, { recursive: true, force: true })
		}
	})()

	return { done }
}

export async function prepare(document: string | undefined, subject: string, text?: string): Promise<Review> {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-mdreview-"))
	let file = document

	if (text !== undefined) {
		file = path.join(directory, "last-message.md")
		await writeFile(file, text, { mode: 0o600 })
	}

	if (!file) throw new Error("nothing to review")

	return { document: file, stdin: text !== undefined, subject, output: path.join(directory, "review.md"), directory }
}

export default function (pi: ExtensionAPI): void {
	const start = async (
		ctx: ExtensionCommandContext,
		make: () => Promise<Review | { refused: string }>,
	): Promise<void> => {
		let rex: Rex | undefined

		try {
			rex = await rexFromEnv(process.env, pi)
		} catch (error) {
			ctx.ui.notify(`mdreview: ${error instanceof Error ? error.message : String(error)}`, "error")

			return
		}

		if (!rex) {
			ctx.ui.notify("mdreview opens in a Rex floating layer, so it needs pi running in Rex", "error")

			return
		}

		const made = await make().catch((error: Error) => ({ refused: error.message }))

		if ("refused" in made) {
			ctx.ui.notify(made.refused, "error")

			return
		}

		const review = made

		try {
			await open(pi, ctx, rex, review)
			ctx.ui.notify("mdreview is open: :wq sends the review, :q! drops it", "info")
		} catch (error) {
			await rm(review.directory, { recursive: true, force: true })
			ctx.ui.notify(`mdreview: ${error instanceof Error ? error.message : String(error)}`, "error")
		}
	}

	pi.registerCommand("mdreview", {
		description: "Review a Markdown file in mdreview and send the review to the agent",
		handler: async (args, ctx) => {
			await start(ctx, async () => {
				const given = args
					.trim()
					.replace(/^@/, "")
					.replace(/^(['"])(.*)\1$/, "$2")

				if (!given) return { refused: "Usage: /mdreview <file>" }

				const file = path.resolve(ctx.cwd, given)
				await readFile(file).catch(() => {
					throw new Error(`Can't read ${given}`)
				})

				return prepare(file, `\`${path.relative(ctx.cwd, file) || given}\``)
			})
		},
	})

	pi.registerCommand("mdreview-last", {
		description: "Review the agent's last message in mdreview and send the review to the agent",
		handler: async (_args, ctx) => {
			await start(ctx, async () => {
				const text = lastAssistantText(ctx.sessionManager.getBranch())

				if (!text) return { refused: "No assistant message on this branch" }

				return prepare(undefined, "your last message", text)
			})
		},
	})
}

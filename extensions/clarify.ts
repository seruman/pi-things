import { type Api, type Model, type UserMessage, complete } from "@earendil-works/pi-ai/compat"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

const USAGE = "Usage: /clarify <rough prompt> | /clarify with editor text | add -clarify anywhere in a message"
const STATUS_KEY = "clarify"
const MARKER_RE = /(?:^|\s)-clarify(?=\s|$|[.,;:!?…])/gi

const SYSTEM_PROMPT = `Rewrite the user's rough prompt into a clearer prompt for a coding agent.

Rules:
- Keep the exact intent. Do not add scope, requirements, stack choices, or preferences.
- Replace long descriptions with standard technical terms when the match is obvious.
- Preserve names, paths, numbers, constraints, UI text, errors, and acceptance criteria.
- Keep the user's language.
- If it is already clear, only lightly clean it up.
- Do not answer the request. Only output the rewritten prompt.`

type RewriteContext = Pick<ExtensionContext, "hasUI" | "model" | "modelRegistry" | "ui">

function hasClarifyMarker(text: string): boolean {
	const value = String(text ?? "")
	if (value.trim() === "-clarify") return true
	MARKER_RE.lastIndex = 0
	return MARKER_RE.test(value)
}

function stripClarifyMarker(text: string): string {
	MARKER_RE.lastIndex = 0
	return String(text ?? "")
		.replace(MARKER_RE, " ")
		.replace(/\s+([.,;:!?…])/g, "$1")
		.replace(/\s+/g, " ")
		.trim()
}

function notify(ctx: RewriteContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type)
}

function currentModel(ctx: RewriteContext): Model<Api> | null {
	if (ctx.model) return ctx.model as Model<Api>
	notify(ctx, "No current model selected for /clarify.", "error")
	return null
}

async function rewritePrompt(text: string, ctx: RewriteContext): Promise<string | null> {
	const raw = text.trim()
	if (!raw) {
		notify(ctx, USAGE, "warning")
		return null
	}

	const model = currentModel(ctx)
	if (!model) return null

	ctx.ui.setStatus(STATUS_KEY, `Clarifying with ${model.provider}/${model.id}…`)
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
		if (!auth.ok) throw new Error(auth.error)
		if (!auth.apiKey) throw new Error(`No API key for ${model.provider}`)

		const message: UserMessage = {
			role: "user",
			content: [{ type: "text", text: raw }],
			timestamp: Date.now(),
		}

		const response = await complete(
			model,
			{ systemPrompt: SYSTEM_PROMPT, messages: [message] },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				cacheRetention: "none",
				maxTokens: 2_000,
			},
		)

		if (response.stopReason === "aborted") return null

		const rewritten = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n")
			.trim()

		if (!rewritten) throw new Error("/clarify returned empty text")
		return rewritten
	} catch (error) {
		notify(ctx, error instanceof Error ? error.message : String(error), "error")
		return null
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined)
	}
}

async function putRewriteInEditor(text: string, ctx: RewriteContext): Promise<void> {
	const rewritten = await rewritePrompt(text, ctx)
	if (rewritten === null) return

	ctx.ui.setEditorText(rewritten)
	notify(ctx, "Clarified. Edit if needed, then send.", "info")
}

export default function clarifyExtension(pi: ExtensionAPI): void {
	pi.registerCommand("clarify", {
		description: "Rewrite a rough prompt into a clearer coding-agent prompt",
		handler: async (args, ctx) => {
			const fromArgs = (args ?? "").trim()
			const fromEditor = ctx.hasUI ? ctx.ui.getEditorText().trim() : ""
			const source = fromArgs || fromEditor

			if (!source) {
				notify(ctx, USAGE, "warning")
				return
			}

			await putRewriteInEditor(source, ctx)
		},
	})

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || !hasClarifyMarker(event.text)) {
			return { action: "continue" }
		}

		const source = stripClarifyMarker(event.text)
		if (!source) {
			notify(ctx, USAGE, "warning")
			return { action: "handled" }
		}

		await putRewriteInEditor(source, ctx)
		return { action: "handled" }
	})
}

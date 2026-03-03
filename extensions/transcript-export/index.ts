import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

type AnyRecord = Record<string, unknown>

type ToolResultRender = {
	toolName: string
	content: string
	details: string
	detailsRaw?: unknown
	isError: boolean
	timestamp: string
}

const DEFAULT_DEV_OUTPUT_FILE = "transcript-dev.html"

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;")
}

function formatTime(timestamp: unknown): string {
	if (typeof timestamp === "number") return new Date(timestamp).toLocaleString()
	if (typeof timestamp === "string") return new Date(timestamp).toLocaleString()
	return "Unknown time"
}

function prettyJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

function roleStyle(role: string): { badge: string; card: string } {
	switch (role) {
		case "user":
			return { badge: "bg-white text-black", card: "bg-white text-black" }
		case "assistant":
			return { badge: "bg-yellow-300 text-black", card: "bg-yellow-100 text-black" }
		case "toolResult":
			return { badge: "bg-yellow-300 text-black", card: "bg-yellow-100 text-black" }
		case "bashExecution":
			return { badge: "bg-lime-300 text-black", card: "bg-lime-100 text-black" }
		case "custom":
			return { badge: "bg-fuchsia-300 text-black", card: "bg-fuchsia-100 text-black" }
		default:
			return { badge: "bg-zinc-300 text-black", card: "bg-zinc-100 text-black" }
	}
}

function messageContentToText(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""

	const parts: string[] = []
	for (const block of content) {
		const b = block as AnyRecord
		if (b.type === "text") {
			parts.push(typeof b.text === "string" ? b.text : "")
			continue
		}
		if (b.type === "image") {
			parts.push("[image omitted]")
			continue
		}
		parts.push(prettyJson(block))
	}
	return parts.join("\n\n")
}

function renderInlineMarkdown(text: string): string {
	let html = escapeHtml(text)
	html = html.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`)
	html = html.replace(/\*\*([^*]+)\*\*/g, (_m, bold) => `<strong>${bold}</strong>`)
	html = html.replace(/\*([^*]+)\*/g, (_m, italic) => `<em>${italic}</em>`)
	html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
		const safeUrl = escapeHtml(url)
		return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="underline">${label}</a>`
	})
	return html
}

function markdownToHtml(raw: string): string {
	const lines = raw.replaceAll("\r\n", "\n").split("\n")
	const out: string[] = []
	let inCode = false
	let inUl = false
	let inOl = false

	const closeLists = () => {
		if (inUl) {
			out.push("</ul>")
			inUl = false
		}
		if (inOl) {
			out.push("</ol>")
			inOl = false
		}
	}

	for (const line of lines) {
		if (line.trimStart().startsWith("```")) {
			closeLists()
			if (!inCode) {
				const lang = line.trimStart().slice(3).trim()
				out.push(`<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>`)
				inCode = true
			} else {
				out.push("</code></pre>")
				inCode = false
			}
			continue
		}

		if (inCode) {
			out.push(`${escapeHtml(line)}\n`)
			continue
		}

		const heading = line.match(/^\s*(#{1,6})\s+(.*)$/)
		if (heading) {
			closeLists()
			const level = heading[1].length
			out.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`)
			continue
		}

		const ul = line.match(/^\s*[-*]\s+(.*)$/)
		if (ul) {
			if (!inUl) {
				if (inOl) {
					out.push("</ol>")
					inOl = false
				}
				out.push("<ul>")
				inUl = true
			}
			out.push(`<li>${renderInlineMarkdown(ul[1])}</li>`)
			continue
		}

		const ol = line.match(/^\s*\d+\.\s+(.*)$/)
		if (ol) {
			if (!inOl) {
				if (inUl) {
					out.push("</ul>")
					inUl = false
				}
				out.push("<ol>")
				inOl = true
			}
			out.push(`<li>${renderInlineMarkdown(ol[1])}</li>`)
			continue
		}

		if (!line.trim()) {
			closeLists()
			continue
		}

		closeLists()
		out.push(`<p>${renderInlineMarkdown(line)}</p>`)
	}

	closeLists()
	if (inCode) out.push("</code></pre>")
	return out.join("\n")
}

function renderMarkdownSection(text: string, className = "mt-4"): string {
	return `<div class="${className}"><div class="markdown-block border-2 border-black bg-white text-black p-3 text-[13px] leading-6 break-words">${markdownToHtml(
		text,
	)}</div></div>`
}

function toolResultPreClass(toolName: string): string {
	if (toolName === "bash") return "m-2 border border-black bg-zinc-100 p-2 whitespace-pre overflow-x-auto text-xs"
	return "m-2 border border-black bg-zinc-100 p-2 whitespace-pre-wrap break-words text-xs"
}

function extractEditOldNew(detailsRaw: unknown): { oldText: string; newText: string } | null {
	const d = asRecord(detailsRaw)
	const oldTextCandidates = [d.oldText, d.originalText, d.before, asRecord(d.diff).oldText]
	const newTextCandidates = [d.newText, d.replacementText, d.after, asRecord(d.diff).newText]
	const oldText = oldTextCandidates.find((v) => typeof v === "string") as string | undefined
	const newText = newTextCandidates.find((v) => typeof v === "string") as string | undefined
	if (!oldText || !newText) return null
	return { oldText, newText }
}

function simpleLineDiff(oldText: string, newText: string): string {
	const oldLines = oldText.replaceAll("\r\n", "\n").split("\n")
	const newLines = newText.replaceAll("\r\n", "\n").split("\n")
	const max = Math.max(oldLines.length, newLines.length)
	const out: string[] = []
	for (let i = 0; i < max; i++) {
		const a = oldLines[i]
		const b = newLines[i]
		if (a === b) {
			if (a !== undefined) out.push(`  ${a}`)
			continue
		}
		if (a !== undefined) out.push(`- ${a}`)
		if (b !== undefined) out.push(`+ ${b}`)
	}
	return out.join("\n")
}

function renderEditDiffDetails(detailsRaw: unknown): string {
	const pair = extractEditOldNew(detailsRaw)
	if (!pair) return ""
	const diff = simpleLineDiff(pair.oldText, pair.newText)
	return `<details class="mx-2 mb-2 border-2 border-black bg-white text-black"><summary class="cursor-pointer px-2 py-1 font-black uppercase text-[10px] tracking-wider">Edit diff</summary><pre class="p-2 whitespace-pre overflow-x-auto text-[11px]">${escapeHtml(diff)}</pre></details>`
}

function buildToolResultsByCallId(branch: AnyRecord[]): Map<string, ToolResultRender[]> {
	const byId = new Map<string, ToolResultRender[]>()

	for (const entry of branch) {
		if (entry.type !== "message") continue
		const message = (entry.message ?? {}) as AnyRecord
		if (message.role !== "toolResult") continue
		if (typeof message.toolCallId !== "string" || !message.toolCallId) continue

		const content = messageContentToText(message.content).trim() || "[no text content]"
		const details = message.details === undefined ? "" : prettyJson(message.details)
		const item: ToolResultRender = {
			toolName: typeof message.toolName === "string" ? message.toolName : "unknown",
			content,
			details,
			detailsRaw: message.details,
			isError: Boolean(message.isError),
			timestamp: formatTime(message.timestamp ?? entry.timestamp),
		}

		const arr = byId.get(message.toolCallId) ?? []
		arr.push(item)
		byId.set(message.toolCallId, arr)
	}

	return byId
}

function renderResultStatusChip(isError: boolean): string {
	if (isError)
		return '<span class="ml-2 inline-block border-2 border-black bg-red-300 px-1 py-0.5 text-[10px] leading-none">error</span>'
	return '<span class="ml-2 inline-block border-2 border-black bg-green-300 px-1 py-0.5 text-[10px] leading-none">ok</span>'
}

function renderMatchedToolResults(results: ToolResultRender[]): string {
	if (!results.length) {
		return '<div class="border-2 border-dashed border-black bg-zinc-100 text-black px-2 py-1 text-[11px] uppercase tracking-wider">No tool result found</div>'
	}

	return results
		.map((result) => {
			const diffDetails = result.toolName === "edit" ? renderEditDiffDetails(result.detailsRaw) : ""
			return `<details class="border-2 border-black bg-zinc-50 text-black"><summary class="cursor-pointer px-2 py-1 font-black uppercase text-xs tracking-widest">Tool result${renderResultStatusChip(result.isError)}</summary><div class="px-2 pt-1 text-[10px] uppercase tracking-wider opacity-70">${escapeHtml(result.toolName)} · ${escapeHtml(result.timestamp)}</div><pre class="${toolResultPreClass(result.toolName)}">${escapeHtml(result.content)}</pre>${diffDetails}${result.details ? `<details class="mx-2 mb-2 border-2 border-black bg-white text-black"><summary class="cursor-pointer px-2 py-1 font-black uppercase text-[10px] tracking-wider">Result details</summary><pre class="p-2 whitespace-pre-wrap break-words text-[11px]">${escapeHtml(result.details)}</pre></details>` : ""}</details>`
		})
		.join("\n")
}

function asRecord(value: unknown): AnyRecord {
	return value && typeof value === "object" ? (value as AnyRecord) : {}
}

function short(value: unknown, max = 140): string {
	const s = typeof value === "string" ? value : String(value ?? "")
	return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function field(label: string, value: unknown): string {
	if (value === undefined || value === null || value === "") return ""
	return `<div><span class="font-black uppercase tracking-wider">${escapeHtml(label)}:</span> ${escapeHtml(String(value))}</div>`
}

function listField(label: string, values: unknown): string {
	if (!Array.isArray(values) || values.length === 0) return ""
	const chips = values
		.map((v) => `<span class="inline-block border border-black px-1 py-0.5">${escapeHtml(String(v))}</span>`)
		.join(" ")
	return `<div><span class="font-black uppercase tracking-wider">${escapeHtml(label)}:</span> <span class="inline-flex flex-wrap gap-1 align-middle">${chips}</span></div>`
}

function codeBlock(text: unknown): string {
	if (typeof text !== "string" || !text.trim()) return ""
	return `<pre class="mt-2 border border-black bg-zinc-100 p-2 whitespace-pre-wrap break-words text-xs"><code>${escapeHtml(text)}</code></pre>`
}

function renderKnownToolCallArgs(name: string, args: unknown): string {
	const a = asRecord(args)

	switch (name) {
		case "bash": {
			const command = typeof a.command === "string" ? a.command : ""
			return `<div class="space-y-1 text-xs">${field("timeout", a.timeout)}${codeBlock(command)}</div>`
		}
		case "read":
			return `<div class="space-y-1 text-xs">${field("path", a.path)}${field("offset", a.offset)}${field("limit", a.limit)}</div>`
		case "write": {
			const content = typeof a.content === "string" ? a.content : ""
			return `<div class="space-y-1 text-xs">${field("path", a.path)}${field("content chars", content.length)}${content ? codeBlock(short(content, 500)) : ""}</div>`
		}
		case "edit":
			return `<div class="space-y-1 text-xs">${field("path", a.path)}${field("old chars", typeof a.oldText === "string" ? a.oldText.length : undefined)}${field("new chars", typeof a.newText === "string" ? a.newText.length : undefined)}</div>`
		case "web_search":
			return `<div class="space-y-1 text-xs">${field("query", short(a.query, 240))}${listField("providers", a.providers)}${field("live", a.live)}${field("debug", a.debug)}</div>`
		case "web_fetch":
		case "web_fetch_rendered":
			return `<div class="space-y-1 text-xs">${field("url", a.url)}${field("format", a.format)}${field("timeoutMs", a.timeoutMs)}</div>`
		case "task":
			return `<div class="space-y-1 text-xs">${field("action", a.action)}${field("taskId", a.taskId)}${field("subject", short(a.subject, 200))}${field("status", a.status)}${listField("addBlocks", a.addBlocks)}${listField("addBlockedBy", a.addBlockedBy)}</div>`
		case "subagent": {
			const mode = a.task
				? "single"
				: Array.isArray(a.tasks)
					? "parallel"
					: Array.isArray(a.chain)
						? "chain"
						: "unknown"
			const firstTask =
				typeof a.task === "string"
					? a.task
					: Array.isArray(a.tasks) && a.tasks[0] && typeof asRecord(a.tasks[0]).task === "string"
						? String(asRecord(a.tasks[0]).task)
						: ""
			return `<div class="space-y-1 text-xs">${field("mode", mode)}${field("agent", a.agent)}${field("tasks", Array.isArray(a.tasks) ? a.tasks.length : undefined)}${field("chain", Array.isArray(a.chain) ? a.chain.length : undefined)}${firstTask ? field("task preview", short(firstTask, 220)) : ""}</div>`
		}
		default:
			return `<pre class="mt-2 border border-black bg-zinc-100 p-2 whitespace-pre-wrap break-words text-xs">${escapeHtml(prettyJson(args))}</pre>`
	}
}

function renderAssistantContent(
	content: unknown,
	toolResultsByCallId: Map<string, ToolResultRender[]>,
	consumedToolResultCallIds: Set<string>,
): string {
	if (typeof content === "string") {
		const text = content.trim().length > 0 ? content : "[no text content]"
		return renderMarkdownSection(text)
	}
	if (!Array.isArray(content)) {
		return renderMarkdownSection("[no text content]")
	}

	const items: string[] = []
	for (const block of content) {
		const b = block as AnyRecord
		if (b.type === "text") {
			const text = typeof b.text === "string" && b.text.trim().length > 0 ? b.text : "[empty text block]"
			items.push(renderMarkdownSection(text))
			continue
		}
		if (b.type === "thinking") {
			const thinking = typeof b.thinking === "string" ? b.thinking : ""
			items.push(
				`<details class="mt-4 border-2 border-black bg-white text-black"><summary class="cursor-pointer px-2 py-1 font-black uppercase text-xs tracking-widest">Thinking</summary>${renderMarkdownSection(thinking || "[empty thinking block]", "m-2")}</details>`,
			)
			continue
		}
		if (b.type === "toolCall") {
			const name = typeof b.name === "string" ? b.name : "unknown"
			const callId = typeof b.id === "string" ? b.id : ""
			const matched = callId ? (toolResultsByCallId.get(callId) ?? []) : []
			if (callId && matched.length > 0) consumedToolResultCallIds.add(callId)
			const prettyArgs = renderKnownToolCallArgs(name, b.arguments ?? {})

			items.push(
				`<details class="mt-4 border-2 border-black bg-white text-black"><summary class="cursor-pointer px-2 py-1 font-black uppercase text-xs tracking-widest">Tool call · ${escapeHtml(name)}</summary><div class="px-2 pt-2">${prettyArgs}</div><div class="mt-3 px-2 pb-2 space-y-2">${renderMatchedToolResults(matched)}</div></details>`,
			)
			continue
		}
		if (b.type === "image") {
			items.push(
				'<div class="mt-4 border-2 border-black bg-white text-black px-2 py-1 text-xs font-bold uppercase tracking-wider">[image omitted]</div>',
			)
			continue
		}
		items.push(
			`<details class="mt-4 border-2 border-black bg-white text-black"><summary class="cursor-pointer px-2 py-1 font-black uppercase text-xs tracking-widest">Block · ${escapeHtml(String(b.type ?? "unknown"))}</summary><pre class="p-2 whitespace-pre-wrap break-words text-xs">${escapeHtml(prettyJson(block))}</pre></details>`,
		)
	}

	if (!items.length) {
		items.push(renderMarkdownSection("[no text content]"))
	}

	return items.join("\n")
}

function renderToolResultContent(
	content: string,
	toolName: string,
	isError: boolean,
	detailsRaw?: unknown,
	detailsText?: string,
): string {
	const diffDetails = toolName === "edit" ? renderEditDiffDetails(detailsRaw) : ""
	return `<details class="mt-4 border-2 border-black bg-white text-black"><summary class="cursor-pointer px-2 py-1 font-black uppercase text-xs tracking-widest">Tool result${renderResultStatusChip(isError)}</summary><pre class="${toolResultPreClass(toolName).replace("m-2 ", "p-2 ")}">${escapeHtml(content)}</pre>${diffDetails}${detailsText ? `<details class="mx-2 mb-2 border-2 border-black bg-white text-black"><summary class="cursor-pointer px-2 py-1 font-black uppercase text-[10px] tracking-wider">Result details</summary><pre class="p-2 whitespace-pre-wrap break-words text-[11px]">${escapeHtml(detailsText)}</pre></details>` : ""}</details>`
}

function messageRowClass(role: string): string {
	if (role === "user") return "flex justify-end"
	if (role === "assistant") return "flex justify-start"
	return "flex justify-start"
}

function messageWidthClass(role: string): string {
	if (role === "user" || role === "assistant") return "w-full md:w-[88%] lg:w-[84%]"
	return "w-full md:w-[92%]"
}

function messageMetaClass(role: string): string {
	if (role === "user")
		return "flex flex-wrap items-center justify-end gap-2 text-xs uppercase tracking-widest font-black"
	return "flex flex-wrap items-center gap-2 text-xs uppercase tracking-widest font-black"
}

function renderMessageCard(
	entry: AnyRecord,
	toolResultsByCallId: Map<string, ToolResultRender[]>,
	consumedToolResultCallIds: Set<string>,
): string {
	const message = (entry.message ?? {}) as AnyRecord
	const role = typeof message.role === "string" ? message.role : "unknown"
	const style = roleStyle(role)
	const timestamp = formatTime(message.timestamp ?? entry.timestamp)

	const assistantMeta =
		role === "assistant"
			? [
					typeof message.model === "string" ? `model: ${message.model}` : "",
					typeof message.provider === "string" ? `provider: ${message.provider}` : "",
				]
					.filter(Boolean)
					.join(" · ")
			: ""

	const visibleMetaBits: string[] = []
	if (typeof message.toolName === "string") visibleMetaBits.push(`tool: ${message.toolName}`)

	const details = message.details === undefined ? "" : prettyJson(message.details)
	const rawContent = messageContentToText(message.content)
	const content = rawContent.trim().length > 0 ? rawContent : "[no text content]"
	const hoverTitle = assistantMeta ? ` title="${escapeHtml(assistantMeta)}"` : ""

	const contentSection =
		role === "assistant"
			? renderAssistantContent(message.content, toolResultsByCallId, consumedToolResultCallIds)
			: role === "toolResult"
				? renderToolResultContent(
						content,
						typeof message.toolName === "string" ? message.toolName : "unknown",
						Boolean(message.isError),
						message.details,
						details,
					)
				: renderMarkdownSection(content)

	const detailsSection =
		role !== "toolResult" && details
			? `<details class="mt-4 border-2 border-black bg-white text-black"><summary class="cursor-pointer px-2 py-1 font-black uppercase text-xs tracking-widest">Details</summary><pre class="p-2 whitespace-pre-wrap break-words text-xs">${escapeHtml(details)}</pre></details>`
			: ""

	return `
		<div class="${messageRowClass(role)}">
			<article class="${messageWidthClass(role)} border-4 border-black ${style.card} p-4 md:p-5 shadow-[8px_8px_0_0_#000]"${hoverTitle}>
				<div class="${messageMetaClass(role)}">
					<span class="border-2 border-black px-2 py-1 ${style.badge}">${escapeHtml(role)}</span>
					<span class="border-2 border-black px-2 py-1 bg-zinc-200 text-black">${escapeHtml(timestamp)}</span>
					${visibleMetaBits.length > 0 ? `<span class="border-2 border-black px-2 py-1 bg-cyan-200 text-black">${escapeHtml(visibleMetaBits.join(" · "))}</span>` : ""}
				</div>
				${contentSection}
				${detailsSection}
			</article>
		</div>
	`
}

function renderCompactEvent(type: string, summary: string, payload: unknown, timestamp: unknown): string {
	return `
		<details class="border-2 border-black bg-zinc-100 text-black p-2 text-[11px] leading-5">
			<summary class="cursor-pointer font-black uppercase tracking-wider">${escapeHtml(type)} · ${escapeHtml(summary)}</summary>
			<div class="mt-1 text-[10px] uppercase tracking-widest opacity-70">${escapeHtml(formatTime(timestamp))}</div>
			<pre class="mt-2 whitespace-pre-wrap break-words text-[10px] leading-4 opacity-80">${escapeHtml(prettyJson(payload))}</pre>
		</details>
	`
}

function renderSessionEventCard(entry: AnyRecord): string {
	const type = typeof entry.type === "string" ? entry.type : "event"
	const payload = Object.fromEntries(
		Object.entries(entry).filter(([key]) => key !== "id" && key !== "parentId" && key !== "timestamp"),
	)

	if (type === "thinking_level_change") {
		const level = typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : "unknown"
		return renderCompactEvent(type, level, payload, entry.timestamp)
	}

	if (type === "model_change") {
		const provider = typeof entry.provider === "string" ? entry.provider : "unknown-provider"
		const model = typeof entry.modelId === "string" ? entry.modelId : "unknown-model"
		return renderCompactEvent(type, `${provider}/${model}`, payload, entry.timestamp)
	}

	const timestamp = formatTime(entry.timestamp)
	return `
		<article class="border-4 border-black bg-orange-100 text-black p-4 shadow-[8px_8px_0_0_#000]">
			<div class="flex flex-wrap items-center gap-2 text-xs uppercase tracking-widest font-black">
				<span class="border-2 border-black px-2 py-1 bg-orange-300">${escapeHtml(type)}</span>
				<span class="border-2 border-black px-2 py-1 bg-zinc-200">${escapeHtml(timestamp)}</span>
			</div>
			<pre class="mt-4 whitespace-pre-wrap break-words text-[12px] leading-6">${escapeHtml(prettyJson(payload))}</pre>
		</article>
	`
}

function defaultOutputFile(cwd: string): string {
	return resolve(cwd, DEFAULT_DEV_OUTPUT_FILE)
}

function normalizeOutputPath(args: string, cwd: string): string {
	const candidate = args.trim()
	if (!candidate) return defaultOutputFile(cwd)
	return resolve(cwd, candidate)
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("transcript-html", {
		description: "Export active session branch to a brutalist single-file HTML transcript",
		handler: async (args, ctx) => {
			const branch = ctx.sessionManager.getBranch().map((entry) => entry as unknown as AnyRecord)
			const toolResultsByCallId = buildToolResultsByCallId(branch)
			const consumedToolResultCallIds = new Set<string>()
			const outputFile = normalizeOutputPath(args, ctx.cwd)
			const sessionName = pi.getSessionName() || "Unnamed session"

			const blocks = branch
				.map((entry) => {
					if (entry.type === "message") {
						const message = (entry.message ?? {}) as AnyRecord
						if (
							message.role === "toolResult" &&
							typeof message.toolCallId === "string" &&
							consumedToolResultCallIds.has(message.toolCallId)
						) {
							return ""
						}
						return renderMessageCard(entry, toolResultsByCallId, consumedToolResultCallIds)
					}
					return renderSessionEventCard(entry)
				})
				.filter(Boolean)
				.join("\n")

			const generatedAt = new Date().toLocaleString()
			const html = `<!doctype html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>${escapeHtml(sessionName)} — transcript</title>
	<script src="https://cdn.tailwindcss.com"></script>
	<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css" />
	<style>
		body {
			font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
		}
		.markdown-block h1,
		.markdown-block h2,
		.markdown-block h3,
		.markdown-block h4,
		.markdown-block h5,
		.markdown-block h6 {
			font-weight: 900;
			text-transform: uppercase;
			letter-spacing: 0.06em;
			margin-top: 0.6rem;
			margin-bottom: 0.45rem;
		}
		.markdown-block p,
		.markdown-block ul,
		.markdown-block ol,
		.markdown-block blockquote,
		.markdown-block pre,
		.markdown-block table {
			margin: 0.45rem 0;
		}
		.markdown-block strong {
			font-weight: 900;
		}
		.markdown-block em {
			font-style: italic;
		}
		.markdown-block :not(pre) > code {
			background: #e5e7eb;
			border: 1px solid #000;
			padding: 0.05rem 0.3rem;
		}
		.markdown-block pre {
			border: 2px solid #000;
			background: #e5e7eb;
		}
		.markdown-block pre code {
			display: block;
			padding: 0.65rem;
			overflow-x: auto;
			white-space: pre;
			background: #e5e7eb !important;
			color: #111827 !important;
		}
		.markdown-block blockquote {
			border-left: 4px solid #000;
			padding-left: 0.6rem;
			font-style: italic;
		}
		.nav-active {
			outline: 4px solid #2563eb;
			outline-offset: 4px;
		}
		.search-overlay {
			position: fixed;
			inset: 0;
			background: rgba(0, 0, 0, 0.45);
			display: none;
			align-items: flex-start;
			justify-content: center;
			padding: 8vh 1rem 1rem;
			z-index: 50;
		}
		.search-overlay.open {
			display: flex;
		}
		.search-modal {
			width: min(900px, 100%);
			max-height: 78vh;
			overflow: hidden;
			background: #fff;
			border: 4px solid #000;
			box-shadow: 10px 10px 0 #000;
		}
		.search-item {
			line-height: 1.35;
			text-transform: none;
			letter-spacing: 0;
		}
		.search-item.active {
			background: #fde047;
		}
		.search-item mark {
			background: #86efac;
			border: 1px solid #000;
			padding: 0 2px;
		}
	</style>
</head>
<body class="bg-zinc-50 text-black">
	<main class="max-w-7xl mx-auto px-4 md:px-8 py-8 md:py-12">
		<header class="border-4 border-black bg-red-300 p-5 md:p-7 shadow-[10px_10px_0_0_#000]">
			<p class="text-xs uppercase tracking-[0.2em] font-black">Pi transcript export</p>
			<h1 class="mt-2 text-2xl md:text-4xl font-black leading-tight">${escapeHtml(sessionName)}</h1>
			<div class="mt-4 text-[10px] md:text-[11px] font-bold uppercase tracking-wider text-black/70 break-all">
				${escapeHtml(generatedAt)} · ${escapeHtml(ctx.cwd)} · ${branch.length} entries
			</div>
		</header>

		<section class="mt-8 space-y-6">
			${blocks || '<article class="border-4 border-black bg-white p-4 font-bold">No entries in active branch yet.</article>'}
		</section>
	</main>
	<div id="search-overlay" class="search-overlay" aria-hidden="true">
		<div class="search-modal">
			<div class="border-b-4 border-black p-3 bg-yellow-200 text-black text-xs font-black uppercase tracking-widest">Search blocks (/)</div>
			<div class="p-3 border-b-2 border-black">
				<input id="search-input" type="text" class="w-full border-2 border-black px-3 py-2 text-sm" placeholder="Type to search transcript..." />
			</div>
			<div id="search-results" class="max-h-[55vh] overflow-auto p-2 space-y-1"></div>
		</div>
	</div>
	<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
	<script>
		(() => {
			if (window.hljs) {
				const codeBlocks = document.querySelectorAll("pre code")
				for (const codeBlock of codeBlocks) window.hljs.highlightElement(codeBlock)
			}

			const targets = Array.from(document.querySelectorAll("section article, section details"))
			if (targets.length === 0) return
			for (const [i, el] of targets.entries()) {
				if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1")
				el.setAttribute("data-nav-index", String(i))
			}

			const overlay = document.getElementById("search-overlay")
			const input = document.getElementById("search-input")
			const resultsEl = document.getElementById("search-results")
			const searchData = targets.map((el, i) => ({ i, text: (el.textContent || "").replace(/\s+/g, " ").trim() }))
			let searchOpen = false
			let searchResults = []
			let searchIndex = 0
			let searchQuery = ""

			let index = 0
			const select = (next, { smooth = false } = {}) => {
				index = Math.max(0, Math.min(targets.length - 1, next))
				targets.forEach((el) => el.classList.remove("nav-active"))
				const current = targets[index]
				current.classList.add("nav-active")
				current.scrollIntoView({ block: "nearest", behavior: smooth ? "smooth" : "auto" })
			}

			const toggleCurrentFold = () => {
				let current = targets[index]
				if (!(current instanceof HTMLDetailsElement)) {
					current = current.querySelector("details") || current
				}
				if (current instanceof HTMLDetailsElement) current.open = !current.open
			}

			const escHtml = (value) =>
				String(value || "")
					.replaceAll("&", "&amp;")
					.replaceAll("<", "&lt;")
					.replaceAll(">", "&gt;")
					.replaceAll('"', "&quot;")
					.replaceAll("'", "&#39;")

			const previewWithMatch = (text, query) => {
				const t = String(text || "")
				const q = String(query || "").trim().toLowerCase()
				if (!q) return escHtml(t.slice(0, 180))
				const pos = t.toLowerCase().indexOf(q)
				if (pos < 0) return escHtml(t.slice(0, 180))
				const start = Math.max(0, pos - 60)
				const end = Math.min(t.length, pos + q.length + 100)
				const before = t.slice(start, pos)
				const hit = t.slice(pos, pos + q.length)
				const after = t.slice(pos + q.length, end)
				const prefix = start > 0 ? "…" : ""
				const suffix = end < t.length ? "…" : ""
				return escHtml(prefix + before) + "<mark>" + escHtml(hit) + "</mark>" + escHtml(after + suffix)
			}

			const renderSearchResults = () => {
				if (!resultsEl) return
				if (!searchQuery) {
					resultsEl.innerHTML =
						'<div class="border-2 border-black p-3 text-sm">Type to search. <span class="font-black">Enter</span> to jump, <span class="font-black">↑/↓</span> or <span class="font-black">j/k</span> to move.</div>'
					return
				}
				if (searchResults.length === 0) {
					resultsEl.innerHTML = '<div class="border-2 border-black p-2 text-sm">No matches</div>'
					return
				}
				const visibleCount = Math.min(50, searchResults.length)
				searchIndex = Math.max(0, Math.min(searchIndex, visibleCount - 1))
				resultsEl.innerHTML = searchResults
					.slice(0, 50)
					.map((r, idx) => {
						const cls = idx === searchIndex ? "search-item active" : "search-item"
						const preview = previewWithMatch(r.text, searchQuery)
						return (
							'<button type="button" class="' +
							cls +
							' w-full text-left border-2 border-black p-2 text-sm" data-result-idx="' +
							idx +
							'"><div class="text-[10px] uppercase tracking-wider opacity-70">#' +
							(r.i + 1) +
							'</div><div class="mt-1 break-words">' +
							preview +
							"</div></button>"
						)
					})
					.join("")
				const buttons = Array.from(resultsEl.querySelectorAll("button"))
				buttons.forEach((btn) => {
					btn.addEventListener("click", () => {
						const idx = Number(btn.getAttribute("data-result-idx") || "0")
						searchIndex = idx
						goToSearchSelection()
					})
				})
				const activeBtn = buttons[searchIndex]
				if (activeBtn) activeBtn.scrollIntoView({ block: "nearest", behavior: "auto" })
			}

			const openSearch = () => {
				if (!overlay || !input) return
				searchOpen = true
				overlay.classList.add("open")
				overlay.setAttribute("aria-hidden", "false")
				input.value = ""
				searchQuery = ""
				searchResults = []
				searchIndex = 0
				renderSearchResults()
				input.focus()
			}

			const closeSearch = () => {
				if (!overlay) return
				searchOpen = false
				overlay.classList.remove("open")
				overlay.setAttribute("aria-hidden", "true")
			}

			const goToSearchSelection = () => {
				if (!searchResults.length) return
				const selected = searchResults[Math.max(0, Math.min(searchResults.length - 1, searchIndex))]
				closeSearch()
				select(selected.i, { smooth: true })
			}

			if (input) {
				input.addEventListener("input", () => {
					searchQuery = input.value.trim()
					const q = searchQuery.toLowerCase()
					searchResults = q ? searchData.filter((r) => r.text.toLowerCase().includes(q)) : []
					searchIndex = 0
					renderSearchResults()
				})
			}

			if (overlay) {
				overlay.addEventListener("click", (event) => {
					if (event.target === overlay) closeSearch()
				})
			}

			select(0, { smooth: false })

			document.addEventListener("keydown", (event) => {
				const activeTag = document.activeElement?.tagName?.toLowerCase()

				if (searchOpen) {
					if (event.key === "Escape") {
						event.preventDefault()
						closeSearch()
						return
					}
					if (event.key === "Enter") {
						event.preventDefault()
						goToSearchSelection()
						return
					}

					const isTypingField = activeTag === "input" || activeTag === "textarea"
					if (isTypingField) {
						if (event.key === "ArrowDown") {
							event.preventDefault()
							searchIndex = Math.min(searchIndex + 1, Math.max(0, Math.min(49, searchResults.length - 1)))
							renderSearchResults()
							return
						}
						if (event.key === "ArrowUp") {
							event.preventDefault()
							searchIndex = Math.max(searchIndex - 1, 0)
							renderSearchResults()
						}
						return
					}

					if (event.key === "j" || event.key === "ArrowDown") {
						event.preventDefault()
						searchIndex = Math.min(searchIndex + 1, Math.max(0, Math.min(49, searchResults.length - 1)))
						renderSearchResults()
						return
					}
					if (event.key === "k" || event.key === "ArrowUp") {
						event.preventDefault()
						searchIndex = Math.max(searchIndex - 1, 0)
						renderSearchResults()
					}
					return
				}

				if (event.key === "/" && activeTag !== "input" && activeTag !== "textarea") {
					event.preventDefault()
					openSearch()
					return
				}

				if (activeTag === "input" || activeTag === "textarea") return

				if (event.key === "j") {
					event.preventDefault()
					select(index + 1)
					return
				}
				if (event.key === "k") {
					event.preventDefault()
					select(index - 1)
					return
				}
				if (event.key === "f" || event.key === "z") {
					event.preventDefault()
					toggleCurrentFold()
				}
			})
		})()
	</script>
</body>
</html>`

			await mkdir(dirname(outputFile), { recursive: true })
			await writeFile(outputFile, html, "utf8")

			const message = `Transcript exported to ${outputFile}`
			if (ctx.hasUI) ctx.ui.notify(message, "info")
			else console.log(message)
		},
	})
}

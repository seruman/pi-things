import { Readability } from "@mozilla/readability"
import { Type } from "@sinclair/typebox"
import { parseHTML } from "linkedom"
import { Markit } from "markit-ai"
import { runLightpandaFetch } from "./lightpanda"

export type FetchMode = "http" | "rendered"
export type FetchFormat = "auto" | "markdown" | "text" | "html"

export type FetchRecord = {
	url: string
	title: string
	content: string
	error: string | null
}

export type FetchDetails = {
	phase?: string
	progress?: number
	mode?: FetchMode
	title?: string
	totalChars?: number
	truncated?: boolean
	durationMs?: number
	error?: string
	urlCount?: number
	fetchedCount?: number
}

export const MAX_INLINE_CONTENT = 30_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

const markit = new Markit()

export function normalizeMarkdown(text: string): string {
	return text
		.replace(/\u00a0/g, " ")
		.replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
		.replace(/ +/g, " ")
		.replace(/\s+,/g, ",")
		.replace(/\s+\./g, ".")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
}

export const fetchParams = Type.Object({
	url: Type.Optional(Type.String({ description: "URL to fetch" })),
	urls: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 10, description: "URLs to fetch in batch" })),
	format: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("markdown"), Type.Literal("text"), Type.Literal("html")], {
			description: "Output format (default: auto)",
		}),
	),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 120000, description: "Request timeout in ms" })),
	perUrlMaxChars: Type.Optional(
		Type.Integer({ minimum: 200, maximum: MAX_INLINE_CONTENT, description: "Max chars per URL (default: 3000)" }),
	),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Batch fetch concurrency (default: 3)" })),
})

function normalizeError(error: unknown): string {
	if (!(error instanceof Error)) return String(error)
	const cause = (error as { cause?: unknown }).cause
	if (cause instanceof Error) {
		const code = (cause as { code?: string }).code
		const detail = code ? `${cause.message} (${code})` : cause.message
		return `${error.message}: ${detail}`
	}
	return error.message
}

function fallbackTitle(url: string): string {
	try {
		const u = new URL(url)
		const seg = u.pathname.split("/").filter(Boolean).pop()
		return seg || u.hostname || url
	} catch {
		return url
	}
}

function ensureHttpUrl(input: string): string {
	const parsed = new URL(input)
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Only http/https URLs are supported: ${input}`)
	}
	return parsed.toString()
}

function looksLikeHtml(text: string): boolean {
	const head = text.slice(0, 1200).toLowerCase()
	return head.includes("<!doctype html") || head.includes("<html") || head.includes("<body") || head.includes("<head")
}

function looksLikeMarkdown(text: string): boolean {
	const head = text.slice(0, 1200)
	return /^\s*#\s+\S+/m.test(head) || /^\s*[-*]\s+\S+/m.test(head) || /^\s*```/m.test(head) || /^\s*---\n/m.test(head)
}

function extractTitleFromMarkdown(markdown: string, url: string): string {
	const lines = markdown.split("\n")
	for (const line of lines) {
		const t = line.trim()
		if (t.toLowerCase().startsWith("title:")) {
			const v = t.slice(6).trim()
			if (v) return v
		}
	}
	for (const line of lines) {
		const t = line.trim()
		if (t.startsWith("# ")) return t.slice(2).trim() || fallbackTitle(url)
	}
	return fallbackTitle(url)
}

async function convertHtmlToMarkdown(html: string): Promise<string> {
	const { markdown } = await markit.convert(Buffer.from(html), { extension: ".html" })
	return markdown.trim() || html
}

async function getHtmlViews(rawHtml: string, url: string): Promise<{ title: string; markdown: string; text: string }> {
	const { document } = parseHTML(rawHtml)

	const readability = new Readability(document)
	const article = readability.parse()
	if (article?.content) {
		const markdown = await convertHtmlToMarkdown(article.content)
		const text = parseHTML(article.content).document.body?.textContent?.replace(/\s+/g, " ").trim() || ""
		return {
			title: article.title?.trim() || document.title?.trim() || fallbackTitle(url),
			markdown: markdown || rawHtml,
			text: text || markdown || rawHtml,
		}
	}

	const markdown = await convertHtmlToMarkdown(rawHtml)
	const text = document.body?.textContent?.replace(/\s+/g, " ").trim() || ""
	return {
		title: document.title?.trim() || fallbackTitle(url),
		markdown: markdown || rawHtml,
		text: text || markdown || rawHtml,
	}
}

function formatAcceptHeader(format: FetchFormat): string {
	if (format === "markdown")
		return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
	if (format === "text") return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
	if (format === "html")
		return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
	return "text/markdown;q=1.0, text/plain;q=0.9, text/html;q=0.8, application/xhtml+xml;q=0.7, */*;q=0.1"
}

async function buildRecord(url: string, raw: string, contentType: string | undefined, format: FetchFormat): Promise<FetchRecord> {
	const normalizedType = (contentType || "").split(";")[0].trim().toLowerCase()
	const isHtml =
		normalizedType.includes("text/html") ||
		normalizedType.includes("application/xhtml+xml") ||
		(!normalizedType && looksLikeHtml(raw))
	const isMarkdown = normalizedType.includes("text/markdown") || (!normalizedType && looksLikeMarkdown(raw) && !isHtml)

	if (format === "html") {
		const title = isHtml ? (await getHtmlViews(raw, url)).title : fallbackTitle(url)
		return { url, title, content: raw, error: null }
	}

	if (isHtml) {
		const html = await getHtmlViews(raw, url)
		if (format === "text") return { url, title: html.title, content: html.text, error: null }
		return { url, title: html.title, content: html.markdown, error: null }
	}

	if (format === "text") return { url, title: fallbackTitle(url), content: raw, error: null }

	if (format === "markdown") {
		if (isMarkdown) {
			const normalized = normalizeMarkdown(raw)
			return { url, title: extractTitleFromMarkdown(normalized, url), content: normalized, error: null }
		}
		return { url, title: fallbackTitle(url), content: normalizeMarkdown(raw), error: null }
	}

	if (isMarkdown) {
		const normalized = normalizeMarkdown(raw)
		return { url, title: extractTitleFromMarkdown(normalized, url), content: normalized, error: null }
	}
	return { url, title: fallbackTitle(url), content: raw, error: null }
}

export async function fetchOneHttp(
	url: string,
	format: FetchFormat,
	signal: AbortSignal | undefined,
	timeoutMs = 30_000,
): Promise<FetchRecord> {
	const target = ensureHttpUrl(url.trim())
	const timeoutSignal = AbortSignal.timeout(timeoutMs)
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

	try {
		const response = await fetch(target, {
			signal: requestSignal,
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
				Accept: formatAcceptHeader(format),
			},
		})

		if (!response.ok) {
			return {
				url: target,
				title: fallbackTitle(target),
				content: "",
				error: `HTTP ${response.status}: ${response.statusText}`,
			}
		}

		const contentLength = Number(response.headers.get("content-length") || "0")
		if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
			return {
				url: target,
				title: fallbackTitle(target),
				content: "",
				error: `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`,
			}
		}

		const raw = await response.text()
		const sizeBytes = Buffer.byteLength(raw, "utf8")
		if (sizeBytes > MAX_RESPONSE_BYTES) {
			return {
				url: target,
				title: fallbackTitle(target),
				content: "",
				error: `Response too large (${Math.round(sizeBytes / 1024 / 1024)}MB)`,
			}
		}

		return await buildRecord(target, raw, response.headers.get("content-type") || undefined, format)
	} catch (error) {
		return { url: target, title: fallbackTitle(target), content: "", error: normalizeError(error) }
	}
}

export async function fetchOneRendered(
	url: string,
	format: FetchFormat,
	signal: AbortSignal | undefined,
	timeoutMs = 30_000,
): Promise<FetchRecord> {
	const target = ensureHttpUrl(url.trim())
	const lp = await runLightpandaFetch(target, timeoutMs, signal)

	if (!lp.content) {
		return {
			url: target,
			title: fallbackTitle(target),
			content: "",
			error: lp.error || "rendered fetch returned no content",
		}
	}

	const sizeBytes = Buffer.byteLength(lp.content, "utf8")
	if (sizeBytes > MAX_RESPONSE_BYTES) {
		return {
			url: target,
			title: fallbackTitle(target),
			content: "",
			error: `Response too large (${Math.round(sizeBytes / 1024 / 1024)}MB)`,
		}
	}

	return await buildRecord(target, lp.content, looksLikeHtml(lp.content) ? "text/html" : "text/plain", format)
}

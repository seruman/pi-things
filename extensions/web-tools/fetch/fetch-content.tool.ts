import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { fetchOneHttp } from "./fetch-lib"
import { registerFetchTool } from "./register-fetch-tool"

export function registerFetchContentTool(pi: ExtensionAPI) {
	registerFetchTool(pi, {
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch URL content with regular HTTP and extract readable output. Supports single url or batch urls, format=auto|markdown|text|html, timeoutMs, perUrlMaxChars, concurrency. Prefer urls[] when fetching multiple links.",
		mode: "http",
		executeFetch: fetchOneHttp,
	})
}

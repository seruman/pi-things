import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { fetchOneRendered } from "./fetch-lib"
import { registerFetchTool } from "./register-fetch-tool"

export function registerFetchRenderedTool(pi: ExtensionAPI) {
	registerFetchTool(pi, {
		name: "web_fetch_rendered",
		label: "Web Fetch Rendered",
		description:
			"Fetch URL content through browser rendering (Lightpanda) and extract readable output. Supports single url or batch urls, format=auto|markdown|text|html, timeoutMs, perUrlMaxChars, concurrency. Prefer urls[] when fetching multiple links.",
		mode: "rendered",
		executeFetch: fetchOneRendered,
	})
}

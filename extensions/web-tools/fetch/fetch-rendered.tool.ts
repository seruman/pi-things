import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { fetchOneRendered } from "./fetch-lib"
import { registerFetchTool } from "./register-fetch-tool"

export function registerFetchRenderedTool(pi: ExtensionAPI) {
	registerFetchTool(pi, {
		name: "web_fetch_rendered",
		label: "Web Fetch Rendered",
		description:
			"Fetch URL content through browser rendering (Lightpanda) and extract readable output. Supports url, format=auto|markdown|text|html, timeoutMs, and perUrlMaxChars.",
		mode: "rendered",
		executeFetch: fetchOneRendered,
	})
}

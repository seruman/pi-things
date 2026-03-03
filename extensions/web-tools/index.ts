import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { registerFetchContentTool } from "./fetch/fetch-content.tool"
import { registerFetchRenderedTool } from "./fetch/fetch-rendered.tool"
import { registerBraveSearchTool } from "./search/brave-search.tool"
import { registerSearchFallbackTool } from "./search/search.tool"

export default function (pi: ExtensionAPI) {
	registerBraveSearchTool(pi)
	registerSearchFallbackTool(pi)
	registerFetchContentTool(pi)
	registerFetchRenderedTool(pi)
}

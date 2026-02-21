import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { registerFetchContentTool } from "./fetch/fetch-content.tool"
import { registerFetchRenderedTool } from "./fetch/fetch-rendered.tool"
import { registerSearchTool } from "./search/search.tool"

export default function (pi: ExtensionAPI) {
	registerSearchTool(pi)
	registerFetchContentTool(pi)
	registerFetchRenderedTool(pi)
}

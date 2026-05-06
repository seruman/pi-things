import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { registerBraveSearchTool } from "../web-tools/search/brave-search.tool"

export default function (pi: ExtensionAPI) {
	registerBraveSearchTool(pi)
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerBraveSearchTool } from "../web-tools/search/brave-search.tool"

export default function (pi: ExtensionAPI) {
	registerBraveSearchTool(pi)
}

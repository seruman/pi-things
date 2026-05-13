import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerFetchContentTool } from "../web-tools/fetch/fetch-content.tool"
import { registerFetchRenderedTool } from "../web-tools/fetch/fetch-rendered.tool"

export default function (pi: ExtensionAPI) {
	registerFetchContentTool(pi)
	registerFetchRenderedTool(pi)
}

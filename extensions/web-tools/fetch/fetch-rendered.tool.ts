import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { fetchOneRendered } from "./fetch-lib";
import { registerFetchTool } from "./register-fetch-tool";

export function registerFetchRenderedTool(pi: ExtensionAPI) {
  registerFetchTool(pi, {
    name: "web_fetch_rendered",
    label: "Web Fetch Rendered",
    description:
      "Fetch URL content through browser rendering (Lightpanda) and extract readable output. Supports format=auto|markdown|text|html and timeoutMs.",
    mode: "rendered",
    executeFetch: fetchOneRendered,
  });
}

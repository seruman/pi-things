import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { FetchDetails, GetFetchDetails } from "./fetch-lib";

function firstText<T extends Record<string, unknown>>(result: AgentToolResult<T>): string {
  for (const c of result.content) {
    if (c.type === "text") return c.text ?? "";
  }
  return "";
}

export function renderFetchResult(result: AgentToolResult<FetchDetails>, opts: ToolRenderResultOptions, theme: Theme): Text {
  const d = result.details;
  if (opts.isPartial) {
    const p = Math.max(0, Math.min(1, d.progress ?? 0));
    const filled = Math.floor(p * 10);
    const bar = "█".repeat(filled) + "░".repeat(10 - filled);
    return new Text(theme.fg("accent", `[${bar}] ${d.phase || "fetching"}`), 0, 0);
  }

  if (d.error) return new Text(theme.fg("error", `Error: ${d.error}`), 0, 0);

  const text = firstText(result).trim();
  if (d.urlCount === 1) {
    let status = `${theme.fg("success", d.title || "Content")}${theme.fg("muted", ` (${d.totalChars ?? 0} chars)`)}`;
    if (typeof d.durationMs === "number") {
      status += theme.fg("muted", ` | ${(d.durationMs / 1000).toFixed(1)}s`);
    }
    if (!opts.expanded) {
      return new Text(status, 0, 0);
    }
    const preview = text.length > 500 ? `${text.slice(0, 500)}...` : text;
    return new Text(`${status}\n${theme.fg("dim", preview)}`, 0, 0);
  }

  let statusLine = `${theme.fg((d.successful ?? 0) > 0 ? "success" : "error", `${d.successful ?? 0}/${d.urlCount ?? 0} URLs`)}${theme.fg("muted", " (content stored)")}`;
  if (typeof d.durationMs === "number") {
    statusLine += theme.fg("muted", ` | ${(d.durationMs / 1000).toFixed(1)}s`);
  }
  if (!opts.expanded) {
    return new Text(statusLine, 0, 0);
  }
  const preview = text.length > 500 ? `${text.slice(0, 500)}...` : text;
  return new Text(`${statusLine}\n${theme.fg("dim", preview)}`, 0, 0);
}

export function renderFetchCall(args: Record<string, unknown>, theme: Theme): Text {
  const url = typeof args.url === "string" ? args.url : undefined;
  const urls = Array.isArray(args.urls) ? args.urls.filter((u): u is string => typeof u === "string") : undefined;
  const urlList = urls ?? (url ? [url] : []);
  if (urlList.length === 0) {
    return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)"), 0, 0);
  }

  const lines: string[] = [];
  if (urlList.length === 1) {
    const display = urlList[0].length > 60 ? `${urlList[0].slice(0, 57)}...` : urlList[0];
    lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", display));
  } else {
    lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", `${urlList.length} URLs`));
    for (const u of urlList.slice(0, 5)) {
      const display = u.length > 60 ? `${u.slice(0, 57)}...` : u;
      lines.push(theme.fg("muted", `  ${display}`));
    }
    if (urlList.length > 5) {
      lines.push(theme.fg("muted", `  ... and ${urlList.length - 5} more`));
    }
  }

  return new Text(lines.join("\n"), 0, 0);
}

export function renderGetFetchCall(
  args: { responseId: string; url?: string; urlIndex?: number },
  theme: Theme,
): Text {
  let target = "";
  if (args.url) target = args.url.length > 30 ? `${args.url.slice(0, 27)}...` : args.url;
  else if (args.urlIndex !== undefined) target = `urlIndex=${args.urlIndex}`;
  else target = args.responseId.slice(0, 8);

  return new Text(theme.fg("toolTitle", theme.bold("get_content ")) + theme.fg("accent", target), 0, 0);
}

export function renderGetFetchResult(
  result: AgentToolResult<GetFetchDetails>,
  opts: ToolRenderResultOptions,
  theme: Theme,
): Text {
  const d = result.details;
  if (d.error) {
    return new Text(theme.fg("error", `Error: ${d.error}`), 0, 0);
  }

  const statusLine = theme.fg("success", d.title || "Content") + theme.fg("muted", ` (${d.contentLength ?? 0} chars)`);
  if (!opts.expanded) {
    return new Text(statusLine, 0, 0);
  }

  const text = firstText(result);
  const preview = text.length > 500 ? `${text.slice(0, 500)}...` : text;
  return new Text(`${statusLine}\n${theme.fg("dim", preview)}`, 0, 0);
}

import { spawn } from "node:child_process";

const LIGHTPANDA_COMMAND = process.env.LIGHTPANDA_PATH || "lightpanda";

export async function runLightpandaFetch(
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    const child = spawn(LIGHTPANDA_COMMAND, ["fetch", "--dump", url], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = () => {
      child.kill("SIGKILL");
      finish(null);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      const out = Buffer.concat(chunks).toString("utf8");
      finish(out.trim() ? out : null);
    });
  });
}

import { runAgentBrowser } from "@agent-browser/eve/sandbox";
import type { ToolContext } from "eve/tools";

// The designer's own browser session in its sandbox, for read_brand and look_at_page. It's separate from
// the browser extension's session, so a viewport set here never changes the page the model is browsing.
const SESSION = "designer";

type Envelope<T> = { success?: boolean; data?: T; error?: string };

/** Runs one agent-browser command and returns its data, or throws with what went wrong. */
export async function browse<T = unknown>(ctx: ToolContext, args: string[]): Promise<T | null> {
  const result = await runAgentBrowser<Envelope<T>>(ctx, args, { session: SESSION, abortSignal: ctx.abortSignal });
  if (result.json?.success === false) throw new Error(`The browser couldn't ${args[0]}: ${result.json.error ?? "unknown error"}`);
  if (result.exitCode !== 0) throw new Error(`The browser couldn't ${args[0]}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  return result.json?.data ?? null;
}

/** Opens a page at a width and waits for it (and its web fonts) to finish loading. */
export async function openAt(ctx: ToolContext, url: string, width: number, height: number): Promise<void> {
  await browse(ctx, ["set", "viewport", String(width), String(height)]);
  await browse(ctx, ["open", url]);
  await browse(ctx, ["wait", "--load", "load"]);
  await browse(ctx, ["eval", "document.fonts ? document.fonts.ready.then(() => true) : true"]).catch(() => null);
}

/** A JPEG of the page as it is now, base64, for the model to look at. */
export async function capture(ctx: ToolContext, options: { full: boolean }): Promise<string> {
  const path = `/tmp/designer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  await browse(ctx, ["screenshot", path, ...(options.full ? ["--full"] : []), "--screenshot-format", "jpeg", "--screenshot-quality", "75"]);
  const sandbox = await ctx.getSandbox();
  const bytes = await sandbox.readBinaryFile({ path });
  if (!bytes?.length) throw new Error("The screenshot came back empty.");
  return Buffer.from(bytes).toString("base64");
}

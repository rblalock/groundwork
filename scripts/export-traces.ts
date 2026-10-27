import { createWriteStream } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { organization } from "../schema/schema";
import { closeDb, db } from "../core/db";
import { listTraces, type TurnTrace } from "../core/turn-traces";

// Writes one business's turn traces as JSONL, one turn per line, oldest first:
// `npm run traces:export -- --org <slug> [--since <ISO time>] [--redact] [--out <path>]`. Stdout by default.
// `--redact` blanks values under phone, email, and address keys, and phone numbers and emails in any text.

const SENSITIVE_KEY = /phone|email|address/i;
const PHONE = /\+1\d{10}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** A value with its phones, emails, and addresses taken out, in any key or string, however deep. */
export function redact(value: unknown): unknown {
  if (typeof value === "string") return value.replace(PHONE, "[phone]").replace(EMAIL, "[email]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "[redacted]" : redact(item)]));
  }
  return value;
}

/** One trace as its JSONL line. */
export function traceLine(trace: TurnTrace, options: { redact?: boolean } = {}): string {
  return JSON.stringify({
    traceId: trace.id,
    turnId: trace.turnId,
    source: trace.source,
    modelId: trace.modelId,
    status: trace.status,
    startedAt: trace.startedAt.toISOString(),
    finishedAt: trace.finishedAt?.toISOString() ?? null,
    usage: trace.usage,
    steps: options.redact ? redact(trace.steps) : trace.steps,
  });
}

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      options: { org: { type: "string" }, since: { type: "string" }, redact: { type: "boolean" }, out: { type: "string" } },
    }).values;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
  if (!args.org) {
    console.error("Name the business: npm run traces:export -- --org <slug> [--since <ISO time>] [--redact] [--out <path>]");
    return 1;
  }
  const since = args.since ? new Date(args.since) : undefined;
  if (since && Number.isNaN(since.getTime())) {
    console.error(`--since is not a time: ${args.since}`);
    return 1;
  }
  if (!process.env.DATABASE_URL) {
    console.error("Missing environment variable DATABASE_URL. Set it in .env.local.");
    return 1;
  }

  try {
    const [org] = await db().select({ id: organization.id }).from(organization).where(eq(organization.slug, args.org)).limit(1);
    if (!org) {
      console.error(`No business with the slug "${args.org}".`);
      return 1;
    }
    const traces = (await listTraces(org.id, { since, limit: 10_000 })).reverse();
    const lines = traces.map((trace) => `${traceLine(trace, { redact: args.redact })}\n`);
    if (!args.out) {
      for (const line of lines) process.stdout.write(line);
      return 0;
    }
    const file = createWriteStream(args.out);
    for (const line of lines) file.write(line);
    await new Promise<void>((resolve, reject) => file.on("error", reject).end(resolve));
    console.error(`${traces.length} traces written to ${args.out}`);
    return 0;
  } catch (error) {
    console.error(`Export failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}

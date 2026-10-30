import { createWriteStream } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { organization } from "../schema/schema";
import { readAgentInstructions } from "../core/agent-instructions";
import { buildDataset, FORMATS, type Format, formatLine, metaLine, parseLabels, type ToolSchema } from "../core/dataset";
import { datasetSource } from "../core/dataset-source";
import { closeDb, db } from "../core/db";
import { agentTools } from "./agent-tools";

// Writes one business's turns as training examples, one per JSONL line (docs/post-training.md):
// `npm run traces:dataset -- --org <slug> [--since <ISO time>] [--out <path>] [--format openai|llama]
//   [--labels <a,b>|all] [--history <n>] [--vertical <id>] [--no-redact]`
// Stdout by default; with `--out`, each example's source and labels go to `<out>.meta.jsonl`, line for
// line. Redacted unless `--no-redact`. Counts per label and per reason a turn was dropped go to stderr.

const USAGE =
  "npm run traces:dataset -- --org <slug> [--since <ISO time>] [--out <path>] [--format openai|llama] [--labels <a,b>|all] [--history <n>] [--vertical <id>] [--no-redact]";

/** The tools for every source the traces came from, loaded once each. */
export async function toolsBySource(sources: string[]): Promise<(source: string) => ToolSchema[]> {
  const loaded = new Map<string, ToolSchema[]>();
  for (const source of new Set(sources)) loaded.set(source, await agentTools(source));
  return (source) => loaded.get(source) ?? [];
}

/** Writes lines to a file, or stdout without a path. */
export async function writeLines(path: string | undefined, lines: string[]): Promise<void> {
  if (!path) {
    for (const line of lines) process.stdout.write(`${line}\n`);
    return;
  }
  const file = createWriteStream(path);
  for (const line of lines) file.write(`${line}\n`);
  await new Promise<void>((resolve, reject) => file.on("error", reject).end(resolve));
}

export function countsText(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, n]) => `  ${key}: ${n}`)
    .join("\n");
}

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      options: {
        org: { type: "string" },
        since: { type: "string" },
        out: { type: "string" },
        format: { type: "string", default: "openai" },
        labels: { type: "string" },
        history: { type: "string", default: "3" },
        vertical: { type: "string" },
        "no-redact": { type: "boolean" },
      },
    }).values;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
  if (!args.org) {
    console.error(`Name the business: ${USAGE}`);
    return 1;
  }
  const format = args.format as Format;
  if (!FORMATS.includes(format)) {
    console.error(`--format is openai or llama, not ${args.format}`);
    return 1;
  }
  let labels;
  try {
    labels = parseLabels(args.labels);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
  const history = Number(args.history);
  if (!Number.isInteger(history) || history < 0) {
    console.error(`--history is a whole number of earlier turns, not ${args.history}`);
    return 1;
  }
  const since = args.since ? new Date(args.since) : undefined;
  if (since && Number.isNaN(since.getTime())) {
    console.error(`--since is not a time: ${args.since}`);
    return 1;
  }
  const instructions = readAgentInstructions();
  if (!instructions) {
    console.error("The agent's instructions aren't here: run this from the repo root.");
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
    const { traces, records } = await datasetSource(org.id, { since });
    const toolsFor = await toolsBySource(traces.map((trace) => trace.source));
    const { examples, counts } = buildDataset(
      traces,
      { instructions, toolsFor, defaultVertical: args.vertical ?? process.env.VERTICAL ?? null },
      { records, labels, history, redact: !args["no-redact"] },
    );
    await writeLines(args.out, examples.map((example) => formatLine(example, format)));
    if (args.out) await writeLines(`${args.out.replace(/\.jsonl$/, "")}.meta.jsonl`, examples.map((example) => metaLine(example)));
    const rebuilt = examples.filter((example) => example.meta.reconstructed).length;
    console.error(
      `${examples.length} examples from ${traces.length} turns${args.out ? ` written to ${args.out}` : ""} (${format}${args["no-redact"] ? ", not redacted" : ", redacted"}).` +
        (rebuilt ? ` ${rebuilt} use today's instructions: their turns ran with others or didn't record them.` : ""),
    );
    console.error(countsText(counts));
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

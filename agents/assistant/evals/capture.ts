import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { EvalReporter } from "eve/evals/reporters";
import { readAgentInstructions } from "../../../core/agent-instructions";
import { buildDataset, type Example, llamaLine, metaLine, openaiLine, type QuoteFacts, type TraceInput } from "../../../core/dataset";
import { recordsFor } from "../../../core/dataset-source";
import { db } from "../../../core/db";
import { turnTraces } from "../../../schema/schema";
import { toolsBySource } from "../../../scripts/export-dataset";

// Training examples from an eval run (`npm run evals:capture -- --tag landscaping`): the agent on the
// eval's model is the teacher, and each eval that passed gives its turns as examples. Every eval empties
// the database, so the turns are staged in memory just before each seed truncates, with the quotes their
// labels come from, and written when the run ends: `<EVAL_CAPTURE_DIR>/<time>/` holds
// `dataset.openai.jsonl`, `dataset.llama.jsonl`, and `dataset.meta.jsonl` (each line's eval id and
// verdict), line for line, redacted. `EVAL_CAPTURE_FAILED=1` keeps the turns of failed evals too.

/** The capture directory, when this run captures. */
export function captureDir(): string | null {
  const dir = process.env.EVAL_CAPTURE_DIR?.trim();
  return dir ? resolve(process.cwd(), dir) : null;
}

const staged = new Map<string, TraceInput>();
const quoteFacts = new Map<string, QuoteFacts>();

/** Copies every trace in the database, and the quotes they name, into memory before they are truncated. */
export async function stageTraces(): Promise<void> {
  const rows = await db().select().from(turnTraces);
  for (const row of rows) staged.set(row.id, row);
  for (const orgId of new Set(rows.map((row) => row.orgId))) {
    const { quotes } = await recordsFor(orgId, rows.filter((row) => row.orgId === orgId));
    for (const quote of quotes) quoteFacts.set(quote.quoteId, quote);
  }
}

/** The seeds, each staging the last eval's traces before it truncates the database. */
export function stagingSeeds<T extends Record<string, (...args: never[]) => Promise<unknown>>>(seeds: T): T {
  return Object.fromEntries(
    Object.entries(seeds).map(([name, seed]) => [
      name,
      async (...args: never[]) => {
        await stageTraces();
        return seed(...args);
      },
    ]),
  ) as T;
}

type Finished = { id: string; attempt?: number; verdict: string; sessionIds: string[]; startedAt: number; completedAt: number };

/** An eval's turns: those of its sessions, or, when none match, those that started while it ran (evals run one at a time). */
function turnsOf(run: Finished): { traces: TraceInput[]; matchedBy: "session" | "time" } {
  const all = [...staged.values()];
  const bySession = all.filter((trace) => run.sessionIds.includes(trace.eveSessionId));
  if (bySession.length) return { traces: bySession, matchedBy: "session" };
  const t = (trace: TraceInput) => trace.startedAt.getTime();
  return { traces: all.filter((trace) => t(trace) >= run.startedAt && t(trace) <= run.completedAt), matchedBy: "time" };
}

/** The reporter that collects each eval's verdict and, when the run ends, writes the examples. */
export function captureReporter(dir: string): EvalReporter {
  const finished: Finished[] = [];
  const keepFailed = process.env.EVAL_CAPTURE_FAILED === "1";
  return {
    onRunStart() {},
    onEvalComplete(result) {
      const sessionIds = [result.result.sessionId, ...(result.result.sessions ?? []).map((s) => s.sessionId)].filter((id): id is string => Boolean(id));
      finished.push({
        id: result.id,
        attempt: result.attempt,
        verdict: result.verdict,
        sessionIds: [...new Set(sessionIds)],
        startedAt: Date.parse(result.startedAt),
        completedAt: Date.parse(result.completedAt),
      });
    },
    async onRunComplete() {
      // The last eval's turns are still in the database.
      await stageTraces();
      const instructions = readAgentInstructions();
      if (!instructions) {
        console.error("eval capture: the agent's instructions aren't here; nothing written.");
        return;
      }
      const toolsFor = await toolsBySource([...staged.values()].map((trace) => trace.source));
      const records = { quotes: [...quoteFacts.values()] };
      const lines: Array<{ example: Example; extra: Record<string, unknown> }> = [];
      const counts: Record<string, number> = {};
      for (const run of finished) {
        if (run.verdict !== "passed" && !(keepFailed && run.verdict === "failed")) {
          counts[`eval:${run.verdict}`] = (counts[`eval:${run.verdict}`] ?? 0) + 1;
          continue;
        }
        const { traces, matchedBy } = turnsOf(run);
        const built = buildDataset(traces, { instructions, toolsFor, defaultVertical: process.env.VERTICAL ?? null }, { records, labels: null, history: 10 });
        for (const [key, n] of Object.entries(built.counts)) counts[key] = (counts[key] ?? 0) + n;
        for (const example of built.examples) {
          lines.push({ example, extra: { evalId: run.id, verdict: run.verdict, ...(run.attempt ? { attempt: run.attempt } : {}), matchedBy } });
        }
      }
      const out = join(dir, new Date().toISOString().replace(/[:.]/g, "-"));
      await mkdir(out, { recursive: true });
      const write = (name: string, rows: string[]) => writeFile(join(out, name), rows.map((row) => `${row}\n`).join(""));
      await write("dataset.openai.jsonl", lines.map(({ example }) => openaiLine(example)));
      await write("dataset.llama.jsonl", lines.map(({ example }) => llamaLine(example)));
      await write("dataset.meta.jsonl", lines.map(({ example, extra }) => metaLine(example, extra)));
      const evals = finished.filter((run) => run.verdict === "passed").length;
      console.error(`eval capture: ${lines.length} examples from ${evals} passing evals of ${finished.length}, written to ${out}`);
      for (const [key, n] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) console.error(`  ${key}: ${n}`);
    },
  };
}

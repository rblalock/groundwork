// A trade's scorecard: runs the evals tagged with the pack's id once per condition with `eve eval --json`
// and writes docs/evals/scorecard.md and scorecard.json (scorecard-<id>.md and .json for a pack other
// than landscaping). The conditions differ only by the env the eval server inherits: the baseline has
// the same prices, rules, and notes but no pack instructions.
//   npm run scorecard                        # landscaping, baseline and pack, on the default model
//   npm run scorecard -- --spark             # and the pack condition on Muse Spark
//   npm run scorecard -- --vertical pool     # another pack's evals (irrigation, pool, tree)
//   npm run scorecard -- --model <id> --base-url <url> [--api-key-env NAME]
//                                            # and the pack on a tuned model behind an OpenAI-compatible URL
// Needs the local test database evals use (DATABASE_URL in .env.local); every eval empties it. A tuned
// run writes scorecard-tuned.md (scorecard-<id>-tuned.md) so the committed scorecard stays as it was.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { VERTICAL_BUSINESSES } from "../agents/assistant/evals/seed";
import { estimateCostUsd, ratesFor } from "../core/model-pricing";
import { VERTICALS } from "../verticals";

/** `secret` reaches the eval run but is never written to the scorecard. */
type Condition = { name: string; env: Record<string, string>; secret?: Record<string, string> };

/** A flag's value, or null when it isn't given. */
function option(name: string): string | null {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? "") : null;
}

const id = option("--vertical") ?? "landscaping";
const pack = VERTICALS[id];
if (!pack) {
  console.error(`No pack named "${id}". Packs: ${Object.keys(VERTICALS).join(", ")}.`);
  process.exit(1);
}
const trade = pack.label.toLowerCase();

const CONDITIONS: Condition[] = [
  { name: `Baseline (no ${trade} pack)`, env: { VERTICAL: "none" } },
  { name: `Groundwork (${trade} pack)`, env: { VERTICAL: id } },
];
const SPARK: Condition = { name: "Groundwork on Muse Spark", env: { VERTICAL: id, EVAL_MODEL_ID: "muse-spark-1.3" } };

// A tuned model (docs/post-training.md) behind an OpenAI-compatible URL, on Chat Completions. Only the
// agent moves to it: evals.config.ts builds the judge before it applies these, so the judge stays on Meta.
const tunedModel = option("--model");
const tunedUrl = option("--base-url");
const keyEnv = option("--api-key-env") ?? "TUNED_MODEL_API_KEY";
if ((tunedModel === null) !== (tunedUrl === null) || tunedModel === "" || tunedUrl === "") {
  console.error("A tuned condition needs both: --model <id> --base-url <url> [--api-key-env NAME]");
  process.exit(1);
}
const TUNED: Condition | null =
  tunedModel && tunedUrl
    ? {
        name: `Groundwork (tuned ${tunedModel})`,
        env: { VERTICAL: id, EVAL_MODEL_ID: tunedModel, EVAL_MODEL_BASE_URL: tunedUrl, EVAL_MODEL_API: "chat" },
        // A local server takes any key; the provider's client needs one.
        secret: { EVAL_MODEL_API_KEY: process.env[keyEnv]?.trim() || "none" },
      }
    : null;

// The eval that measures end-to-end completion: quoted, approved, and booked in three messages. Only
// packs with one report completion.
const COMPLETION_EVAL = existsSync(resolve(process.cwd(), `agents/assistant/evals/${id}/approve-and-schedule.eval.ts`))
  ? `${id}/approve-and-schedule`
  : null;

// The same fake switches and blanked credentials the `evals` npm script sets.
const OFFLINE: Record<string, string> = {
  IMESSAGE_FAKE: "1",
  PHOTON_ADMIN_FAKE: "1",
  IMESSAGE_PROJECT_ID: "",
  IMESSAGE_PROJECT_SECRET: "",
  RESEND_API_KEY: "",
  EMAIL_FROM: "",
  EMAIL_FAKE: "1",
  STRIPE_FAKE: "1",
  STRIPE_SECRET_KEY: "",
  STRIPE_WEBHOOK_SECRET: "",
  AGENTMAIL_FAKE: "1",
  AGENTMAIL_API_KEY: "",
  AGENTMAIL_WEBHOOK_SECRET: "",
};

const OUT_DIR = resolve(process.cwd(), "docs/evals");
const OUT_NAME = `${id === "landscaping" ? "scorecard" : `scorecard-${id}`}${TUNED ? "-tuned" : ""}`;

// The parts of `eve eval --json` the scorecard reads.
type Assertion = { name: string; key?: string; score: number; passed: boolean; metadata?: { judge?: string } };
type Usage = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
type ToolCall = { name: string; status: string; output?: unknown };
type EvalResult = {
  id: string;
  verdict: "passed" | "failed" | "scored" | "skipped" | "errored";
  assertions?: Assertion[];
  skipReason?: string;
  startedAt?: string;
  completedAt?: string;
  result?: { derived?: { toolCalls?: ToolCall[]; usage?: Usage; models?: string[] } };
};
type Report = { results: EvalResult[] };

type EvalRow = {
  id: string;
  verdict: EvalResult["verdict"];
  judgeScores: number[];
  failed: string[];
  quotesCreated: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number | null;
};

type Summary = {
  condition: string;
  env: Record<string, string>;
  models: string[];
  judgeModels: string[];
  evals: number;
  passed: number;
  skipped: number;
  passRate: number;
  judgeMean: number | null;
  completed: boolean | null;
  quotesCreated: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costPerQuoteUsd: number | null;
  rows: EvalRow[];
};

function runEvals(condition: Condition): Promise<Report> {
  const bin = resolve(process.cwd(), "node_modules/.bin/eve");
  const args = ["eval", "--agent", "assistant", "--tag", id, "--json"];
  console.error(`\n== ${condition.name}: eve ${args.join(" ")} (${Object.entries(condition.env).map(([k, v]) => `${k}=${v}`).join(" ")})`);
  return new Promise((done, fail) => {
    const child = spawn(bin, args, { env: { ...process.env, ...OFFLINE, ...condition.env, ...condition.secret }, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.on("error", fail);
    // A failed gate exits 1 and still prints the report; only a missing report is an error.
    child.on("close", (code) => {
      const start = stdout.search(/^\{/m);
      if (start < 0) return fail(new Error(`eve eval exited ${code} without a JSON report`));
      try {
        done(JSON.parse(stdout.slice(start)) as Report);
      } catch (error) {
        fail(new Error(`eve eval's JSON report did not parse: ${String(error)}`));
      }
    });
  });
}

const bareModel = (id: string) => id.replace(/^[^/]+\//, "");

/** A create_quote call that finished without a tool error. */
const quoteCreated = (call: ToolCall) =>
  call.name === "create_quote" &&
  call.status === "completed" &&
  !(call.output && typeof call.output === "object" && "error" in call.output);

function evalRow(result: EvalResult): EvalRow {
  const derived = result.result?.derived;
  const usage = derived?.usage ?? {};
  // `inputTokens` is the whole prompt, cache reads included, as the price table expects.
  const tokens = {
    inputTokens: usage.inputTokens ?? 0,
    cachedInputTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
  const model = derived?.models?.[0];
  const assertions = result.assertions ?? [];
  return {
    id: result.id,
    verdict: result.verdict,
    judgeScores: assertions.filter((a) => a.name.startsWith("judge")).map((a) => a.score),
    failed: assertions.filter((a) => !a.passed).map((a) => (a.key ? `${a.key}` : a.name)),
    quotesCreated: (derived?.toolCalls ?? []).filter(quoteCreated).length,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    costUsd: model ? estimateCostUsd(tokens, ratesFor(bareModel(model)).rates) : 0,
    durationMs: result.startedAt && result.completedAt ? Date.parse(result.completedAt) - Date.parse(result.startedAt) : null,
  };
}

function summarize(condition: Condition, report: Report): Summary {
  const rows = report.results.map(evalRow).sort((a, b) => a.id.localeCompare(b.id));
  const ran = rows.filter((row) => row.verdict !== "skipped");
  const passed = ran.filter((row) => row.verdict === "passed").length;
  const judged = ran.flatMap((row) => row.judgeScores);
  const quoting = ran.filter((row) => row.quotesCreated > 0);
  const quotesCreated = quoting.reduce((sum, row) => sum + row.quotesCreated, 0);
  const completion = COMPLETION_EVAL ? rows.find((row) => row.id === COMPLETION_EVAL) : undefined;
  const sum = (pick: (row: EvalRow) => number) => ran.reduce((total, row) => total + pick(row), 0);
  const unique = (values: string[]) => [...new Set(values)].sort();
  return {
    condition: condition.name,
    env: condition.env,
    models: unique(report.results.flatMap((r) => r.result?.derived?.models ?? []).map(bareModel)),
    judgeModels: unique(report.results.flatMap((r) => (r.assertions ?? []).map((a) => a.metadata?.judge ?? "")).filter(Boolean)),
    evals: ran.length,
    passed,
    skipped: rows.length - ran.length,
    passRate: ran.length ? passed / ran.length : 0,
    judgeMean: judged.length ? judged.reduce((a, b) => a + b, 0) / judged.length : null,
    completed: completion && completion.verdict !== "skipped" ? completion.verdict === "passed" : null,
    quotesCreated,
    inputTokens: sum((row) => row.inputTokens),
    outputTokens: sum((row) => row.outputTokens),
    costUsd: sum((row) => row.costUsd),
    // Only the evals that made a quote count toward its cost; the rest are interviews and asks.
    costPerQuoteUsd: quotesCreated ? quoting.reduce((total, row) => total + row.costUsd, 0) / quotesCreated : null,
    rows,
  };
}

const pct = (value: number) => `${Math.round(value * 100)}%`;
const usd = (value: number | null) => (value === null ? "n/a" : `$${value.toFixed(value < 1 ? 4 : 2)}`);
const count = (value: number) => value.toLocaleString("en-US");

function cell(row: EvalRow | undefined): string {
  if (!row) return "n/a";
  if (row.verdict === "skipped") return "skip";
  const scores = row.judgeScores.length ? ` (${row.judgeScores.map((s) => s.toFixed(2)).join(", ")})` : "";
  return `${row.verdict === "passed" ? "pass" : row.verdict}${scores}`;
}

function render(summaries: Summary[], at: Date): string {
  const flags = [id === "landscaping" ? "" : `--vertical ${id}`, TUNED ? `--model ${tunedModel} --base-url <url>` : ""].filter(Boolean).join(" ");
  const command = flags ? `npm run scorecard -- ${flags}` : "npm run scorecard";
  const shortId = (evalId: string) => evalId.replace(new RegExp(`^${id}/`), "");
  const lines = [
    `# ${pack.label} eval scorecard`,
    "",
    `Generated ${at.toISOString()} by \`${command}\`. Agent model: ${[...new Set(summaries.flatMap((s) => s.models))].join(", ") || "n/a"}. ` +
      `Judge model: ${[...new Set(summaries.flatMap((s) => s.judgeModels))].join(", ") || "n/a"}.`,
    "",
    `Every condition runs the same evals against the same seeded business (${VERTICAL_BUSINESSES[id] ?? `LOX ${pack.label}`}: prices, rules, minimum, ` +
      `and notes). The baseline leaves out only the ${trade} instructions.`,
    "",
    "| Condition | Pass rate | Judge mean | Completion | Quotes | Tokens (in / out) | Cost | Cost per quote |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...summaries.map(
      (s) =>
        `| ${s.condition} | ${pct(s.passRate)} (${s.passed}/${s.evals}${s.skipped ? `, ${s.skipped} skipped` : ""}) | ` +
        `${s.judgeMean === null ? "n/a" : s.judgeMean.toFixed(2)} | ${s.completed === null ? "n/a" : s.completed ? "yes" : "no"} | ` +
        `${s.quotesCreated} | ${count(s.inputTokens)} / ${count(s.outputTokens)} | ${usd(s.costUsd)} | ${usd(s.costPerQuoteUsd)} |`,
    ),
    "",
    "Pass rate counts evals whose gates all held. Judge mean is the mean of every judge score. " +
      (COMPLETION_EVAL
        ? `Completion is \`${COMPLETION_EVAL}\`: quoted, approved, and booked in three messages. `
        : "Completion is n/a: this pack has no end-to-end eval yet. ") +
      "Cost is estimated from token counts at " +
      "list prices (core/model-pricing.ts), agent only; cost per quote divides the cost of the evals that made a " +
      "quote by the quotes they made." +
      (TUNED ? ` The tuned model is priced at Muse Wonder's rates unless MODEL_PRICES names ${tunedModel}.` : ""),
    "",
    "## Per eval",
    "",
    `| Eval | ${summaries.map((s) => s.condition).join(" | ")} |`,
    `| --- | ${summaries.map(() => "---").join(" | ")} |`,
  ];
  const ids = [...new Set(summaries.flatMap((s) => s.rows.map((row) => row.id)))].sort();
  for (const evalId of ids) {
    lines.push(`| ${shortId(evalId)} | ${summaries.map((s) => cell(s.rows.find((row) => row.id === evalId))).join(" | ")} |`);
  }
  lines.push("", "Each cell is the verdict and, in parentheses, the judge scores.");
  const failures = summaries.flatMap((s) =>
    s.rows.filter((row) => row.failed.length).map((row) => `- ${s.condition}, ${shortId(row.id)}: ${row.failed.join("; ")}`),
  );
  if (failures.length) lines.push("", "## Failed assertions", "", ...failures);
  return `${lines.join("\n")}\n`;
}

const conditions = [...CONDITIONS, ...(process.argv.includes("--spark") ? [SPARK] : []), ...(TUNED ? [TUNED] : [])];
const summaries: Summary[] = [];
for (const condition of conditions) {
  summaries.push(summarize(condition, await runEvals(condition)));
}
const at = new Date();
await mkdir(OUT_DIR, { recursive: true });
const markdown = render(summaries, at);
await writeFile(resolve(OUT_DIR, `${OUT_NAME}.md`), markdown);
await writeFile(resolve(OUT_DIR, `${OUT_NAME}.json`), `${JSON.stringify({ generatedAt: at.toISOString(), conditions: summaries }, null, 2)}\n`);
console.log(markdown);

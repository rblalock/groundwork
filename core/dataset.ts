// Training examples from turn traces, for post-training an open-weight model on what the assistant did
// (docs/post-training.md). One example per kept turn: the system prompt the turn ran with, a few earlier
// turns of its session, the member's message, and the assistant's steps (tool calls with their
// arguments, tool results, the reply), with the tools it had. Reasoning is left out: it isn't a target.
// Labels come from the records the turn touched. Everything here is pure: scripts/export-dataset.ts and
// the eval capture (agents/assistant/evals/capture.ts) load the traces and records and write the lines.
import type { TraceStep } from "../schema/types";
import { VERTICALS } from "../verticals";
import { type AgentInstructions, instructionsHash, systemPrompt } from "./agent-instructions";
import type { TurnTrace } from "./turn-traces";

/** The most of one tool result an example keeps, in characters. A skill's instructions are kept whole. */
export const RESULT_LIMIT = 4 * 1024;
const DAY_MS = 24 * 60 * 60_000;

export const LABELS = ["quote_approved_unchanged", "visit_booked_clean", "answered", "unverified"] as const;
export type TurnLabel = (typeof LABELS)[number];
/** The labels an export keeps unless `--labels` says otherwise: every one an outcome vouches for. */
export const DEFAULT_LABELS: readonly TurnLabel[] = ["quote_approved_unchanged", "visit_booked_clean", "answered"];

export type DropReason = "not_completed" | "tool_error" | "no_input" | "no_reply" | "truncated_call" | "quote_voided" | "quote_revised";

export type TraceInput = Pick<
  TurnTrace,
  "id" | "turnId" | "eveSessionId" | "source" | "modelId" | "status" | "steps" | "startedAt" | "finishedAt" | "instructionsHash" | "vertical"
>;

/** What the records say about a quote a turn touched. */
export type QuoteFacts = { quoteId: string; status: string; approvedAt: Date | null; revisionTimes: Date[] };
export type TurnRecords = { quotes: QuoteFacts[] };

export type ToolSchema = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; weight?: 0 }
  | { role: "tool"; tool_call_id: string; content: string };

export type ExampleMeta = {
  traceId: string;
  turnId: string;
  eveSessionId: string;
  source: string;
  modelId: string | null;
  vertical: string | null;
  instructionsHash: string | null;
  /** True when the system prompt is today's instructions rather than the ones the turn ran with. */
  reconstructed: boolean;
  labels: TurnLabel[];
  startedAt: string;
};
/** One training example. `turnStart` is the index of the turn's own member message in `messages`. */
export type Example = { messages: ChatMessage[]; tools: ToolSchema[]; turnStart: number; meta: ExampleMeta };

export type DatasetContext = {
  /** The agent's instructions and skills, as they are now (core/agent-instructions.ts). */
  instructions: AgentInstructions;
  /** The tools a turn from a source had (scripts/agent-tools.ts). */
  toolsFor: (source: string) => ToolSchema[];
  /** The pack a trace that predates the `vertical` column ran with. */
  defaultVertical?: string | null;
};

export type Labeled = { keep: true; labels: TurnLabel[] } | { keep: false; reason: DropReason };

const SKILL_TOOL = "eve__skill";
const BOOKING_TOOLS = new Set(["book_visit", "reschedule_visit"]);
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** A tool result the tool itself reports as failed: a failed action, or a `{ error }` output. */
export function isToolError(step: TraceStep): boolean {
  return step.kind === "tool.result" && (step.isError === true || (isObject(step.output) && typeof step.output.error === "string"));
}

/** A call that loads a skill: eve reports it under the skill's name, with that name as its only input. */
const isSkillLoad = (step: TraceStep, skills: ReadonlySet<string>) => step.kind === "tool.call" && Boolean(step.toolName && skills.has(step.toolName));

/** The quotes a turn's tool calls and results name, by `quoteId`. */
export function quotesTouched(steps: TraceStep[]): string[] {
  const ids = new Set<string>();
  for (const step of steps) {
    for (const value of [step.input, step.output]) {
      if (!isObject(value)) continue;
      if (typeof value.quoteId === "string") ids.add(value.quoteId);
      if (isObject(value.quote) && typeof value.quote.quoteId === "string") ids.add(value.quote.quoteId);
    }
  }
  return [...ids];
}

/**
 * Whether a turn is worth training on, and what vouches for it. Kept: completed turns with a member
 * message and a reply, and no tool error. Dropped: a turn whose quote was voided, or revised within a
 * day of the turn. Labels: `quote_approved_unchanged` (a quote it touched was approved and not revised
 * after), `visit_booked_clean` (it booked or moved a visit), `answered` (it replied without a tool), and
 * `unverified` for the rest.
 */
export function labelTurn(trace: TraceInput, records: TurnRecords, skills: ReadonlySet<string> = new Set()): Labeled {
  if (trace.status !== "completed") return { keep: false, reason: "not_completed" };
  const steps = trace.steps;
  if (steps.some(isToolError)) return { keep: false, reason: "tool_error" };
  if (!steps.some((s) => s.kind === "input")) return { keep: false, reason: "no_input" };
  if (!finalReply(steps) && !steps.some((s) => s.kind === "tool.call")) return { keep: false, reason: "no_reply" };
  if (steps.some((s) => s.kind === "tool.call" && s.truncated)) return { keep: false, reason: "truncated_call" };

  const end = (trace.finishedAt ?? trace.startedAt).getTime();
  const touched = new Set(quotesTouched(steps));
  const quotes = records.quotes.filter((q) => touched.has(q.quoteId));
  if (quotes.some((q) => q.status === "void")) return { keep: false, reason: "quote_voided" };
  if (quotes.some((q) => q.revisionTimes.some((at) => at.getTime() > end && at.getTime() - end <= DAY_MS))) {
    return { keep: false, reason: "quote_revised" };
  }

  const labels: TurnLabel[] = [];
  if (quotes.some((q) => q.approvedAt && !q.revisionTimes.some((at) => at.getTime() > q.approvedAt!.getTime()))) labels.push("quote_approved_unchanged");
  if (steps.some((s) => s.kind === "tool.result" && s.toolName && BOOKING_TOOLS.has(s.toolName))) labels.push("visit_booked_clean");
  if (!steps.some((s) => s.kind === "tool.call" && !isSkillLoad(s, skills))) labels.push("answered");
  return { keep: true, labels: labels.length ? labels : ["unverified"] };
}

/** The member's message as text: its words, then a placeholder per file ("[photo: yard-front.jpg]"). */
export function memberMessage(steps: TraceStep[]): string | null {
  const inputs = steps.filter((s) => s.kind === "input");
  if (!inputs.length) return null;
  return inputs
    .map((input) => {
      const files = (input.files ?? []).map((f) => `[${f.mediaType?.startsWith("image/") ? "photo" : "file"}: ${f.name ?? "unnamed"}]`);
      return [input.text ?? "", ...files].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

/** The turn's last message that isn't the model thinking aloud before a tool call. */
function finalReply(steps: TraceStep[]): string | null {
  const replies = steps.filter((s) => s.kind === "message" && s.finishReason !== "tool-calls" && s.text);
  return replies.at(-1)?.text ?? null;
}

const cut = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…[truncated]` : text);
const asText = (value: unknown) => (typeof value === "string" ? value : (JSON.stringify(value) ?? "null"));

/**
 * A turn's assistant side as chat messages: per model step, its calls and their results, then the reply.
 * Results are whole here; `cutResults` shortens them, after redaction has seen all of them.
 */
export function assistantMessages(steps: TraceStep[], skills: ReadonlySet<string>, history = false): ChatMessage[] {
  const out: ChatMessage[] = [];
  const groups: TraceStep[][] = [];
  let current: TraceStep[] | null = null;
  let index: number | null | undefined;
  // Results are matched to their calls by id, wherever they landed; the rest group by model step.
  const results = steps.filter((s) => s.kind === "tool.result");
  for (const step of steps) {
    if (step.kind === "input" || step.kind === "reasoning" || step.kind === "tool.result") continue;
    if (!current || (step.stepIndex !== null && step.stepIndex !== index)) {
      current = [];
      groups.push(current);
      index = step.stepIndex;
    }
    current.push(step);
  }
  const weight = history ? { weight: 0 as const } : {};
  let callNumber = 0;
  for (const group of groups) {
    const text = group.filter((s) => s.kind === "message" && s.text).map((s) => s.text as string).join("\n\n") || null;
    const calls = group.filter((s) => s.kind === "tool.call");
    if (!calls.length) {
      if (text) out.push({ role: "assistant", content: text, ...weight });
      continue;
    }
    const ids = calls.map((call) => call.callId ?? `call_${++callNumber}`);
    out.push({
      role: "assistant",
      content: text,
      tool_calls: calls.map((call, i) => {
        const skill = isSkillLoad(call, skills);
        const args = skill ? { name: call.toolName } : call.input;
        return { id: ids[i], type: "function", function: { name: skill ? SKILL_TOOL : (call.toolName ?? "unknown"), arguments: asText(args ?? {}) } };
      }),
      ...weight,
    });
    calls.forEach((call, i) => {
      const result = call.callId ? results.find((s) => s.callId === call.callId) : undefined;
      const body = asText(result?.output ?? null);
      out.push({ role: "tool", tool_call_id: ids[i], content: body });
    });
  }
  return out;
}

/** The system prompt a trace ran with, and whether it had to be rebuilt from today's instructions. */
export function systemFor(trace: TraceInput, ctx: DatasetContext): { content: string; vertical: string | null; reconstructed: boolean } {
  const vertical = trace.vertical ?? (trace.instructionsHash ? null : (ctx.defaultVertical ?? null));
  const overlay = vertical ? (VERTICALS[vertical]?.instructions ?? null) : null;
  const reconstructed = !trace.instructionsHash || trace.instructionsHash !== instructionsHash(ctx.instructions, overlay);
  return { content: systemPrompt(ctx.instructions, overlay), vertical, reconstructed };
}

const SKILL_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: SKILL_TOOL,
    description: "Loads a skill's instructions.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  },
};

/** One example from a trace and the earlier turns of its session (oldest first), unredacted. */
export function buildExample(trace: TraceInput, earlier: TraceInput[], labels: TurnLabel[], ctx: DatasetContext): Example {
  const skills = new Set(ctx.instructions.skills.map((s) => s.name));
  const system = systemFor(trace, ctx);
  const messages: ChatMessage[] = [{ role: "system", content: system.content }];
  for (const prior of earlier) {
    const said = memberMessage(prior.steps);
    if (said === null) continue;
    messages.push({ role: "user", content: said }, ...assistantMessages(prior.steps, skills, true));
  }
  const turnStart = messages.length;
  messages.push({ role: "user", content: memberMessage(trace.steps) ?? "" }, ...assistantMessages(trace.steps, skills));
  const tools = [...ctx.toolsFor(trace.source), ...(skills.size ? [SKILL_SCHEMA] : [])];
  return {
    messages,
    tools,
    turnStart,
    meta: {
      traceId: trace.id,
      turnId: trace.turnId,
      eveSessionId: trace.eveSessionId,
      source: trace.source,
      modelId: trace.modelId,
      vertical: system.vertical,
      instructionsHash: trace.instructionsHash,
      reconstructed: system.reconstructed,
      labels,
      startedAt: trace.startedAt.toISOString(),
    },
  };
}

/** An example with each tool result cut to `RESULT_LIMIT`, except a skill's instructions. */
export function cutResults(example: Example): Example {
  const skillCalls = new Set(
    example.messages.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).filter((c) => c.function.name === SKILL_TOOL).map((c) => c.id) : [])),
  );
  return {
    ...example,
    messages: example.messages.map((m) => (m.role === "tool" && !skillCalls.has(m.tool_call_id) ? { ...m, content: cut(m.content, RESULT_LIMIT) } : m)),
  };
}

export type DatasetOptions = {
  records: TurnRecords;
  /** Keep only examples with one of these labels; every label when null. */
  labels?: readonly TurnLabel[] | null;
  /** How many earlier turns of the session each example carries. */
  history?: number;
  redact?: boolean;
};

export type Dataset = { examples: Example[]; counts: Record<string, number> };

/**
 * Examples from a set of traces: each kept turn with up to `history` earlier turns of its session, the
 * labels it earned, and redaction unless `redact` is false. `counts` has one entry per label kept and
 * per reason a turn was dropped (`dropped:<reason>`, and `filtered` for labels left out).
 */
export function buildDataset(traces: TraceInput[], ctx: DatasetContext, options: DatasetOptions): Dataset {
  const skills = new Set(ctx.instructions.skills.map((s) => s.name));
  const history = options.history ?? 3;
  const wanted = options.labels ?? null;
  const counts: Record<string, number> = {};
  const bump = (key: string) => (counts[key] = (counts[key] ?? 0) + 1);
  const sessions = new Map<string, TraceInput[]>();
  for (const trace of [...traces].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())) {
    sessions.set(trace.eveSessionId, [...(sessions.get(trace.eveSessionId) ?? []), trace]);
  }
  const examples: Example[] = [];
  for (const turns of sessions.values()) {
    turns.forEach((trace, i) => {
      const labeled = labelTurn(trace, options.records, skills);
      if (!labeled.keep) return bump(`dropped:${labeled.reason}`);
      if (wanted && !labeled.labels.some((l) => wanted.includes(l))) return bump("filtered");
      for (const label of labeled.labels) bump(label);
      const earlier = history > 0 ? turns.slice(Math.max(0, i - history), i) : [];
      const example = buildExample(trace, earlier, labeled.labels, ctx);
      examples.push(cutResults(options.redact === false ? example : redactExample(example)));
    });
  }
  return { examples, counts };
}

// Redaction: the people and places a business's customers are, replaced with placeholders that stay the
// same within one example ("[customer 1]" everywhere Maria Lopez was), so the conversation still reads.

const PERSON_KEY = /^(customerName|contactName)$/;
const PERSON_PARENT = /customer|contact/i;
const ADDRESS_KEY = /address|street|line1/i;
const PHONE_KEY = /phone/i;
const EMAIL_KEY = /email/i;
const PHONE = /\+1\d{10}\b|\(\d{3}\)\s?\d{3}-\d{4}|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const TITLES = new Set(["The", "Mrs", "Miss", "Mister", "Doctor"]);

type Kind = "customer" | "address" | "phone" | "email";

/** Strips a placeholder map for one example: each distinct value gets the next number of its kind. */
class Redactor {
  private readonly known = new Map<string, string>();
  private readonly counts: Record<Kind, number> = { customer: 0, address: 0, phone: 0, email: 0 };

  placeholder(kind: Kind, value: string): string {
    const key = `${kind}:${value.toLowerCase()}`;
    let found = this.known.get(key);
    if (!found) {
      found = `[${kind} ${++this.counts[kind]}]`;
      this.known.set(key, found);
    }
    return found;
  }

  /** The same, in JSON a trace cut short, which doesn't parse: each `"key":"value"` pair, without its parents. */
  collectText(text: string): void {
    for (const [, key, value] of text.matchAll(/"([A-Za-z0-9_]+)":"((?:[^"\\]|\\.)*)"/g)) this.collect({ [key]: value });
  }

  /** Finds the names, addresses, phones, and emails in structured values, by the keys they sit under. */
  collect(value: unknown, parent = ""): void {
    if (Array.isArray(value)) return value.forEach((item) => this.collect(item, parent));
    if (!isObject(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && item.trim()) {
        if (PERSON_KEY.test(key) || (key === "name" && PERSON_PARENT.test(parent))) this.person(item.trim());
        else if (ADDRESS_KEY.test(key) || (ADDRESS_KEY.test(parent) && /^(line1|street|full|formatted)$/i.test(key))) this.address(item.trim());
        // A quote's title is often its address ("412 Oak St"): one that starts with a house number counts.
        else if (key === "title" && /^\d+\s+[A-Za-z]/.test(item.trim())) this.address(item.trim());
        else if (PHONE_KEY.test(key)) this.placeholder("phone", item.trim());
        else if (EMAIL_KEY.test(key)) this.placeholder("email", item.trim());
      } else {
        this.collect(item, key);
      }
    }
  }

  private person(name: string) {
    const label = this.placeholder("customer", name);
    // A first name alone ("Maria") stands for the same person.
    const first = name.split(/\s+/)[0];
    if (/^[A-Z][a-z]{2,}$/.test(first) && !TITLES.has(first) && first !== name) this.known.set(`customer:${first.toLowerCase()}`, label);
  }

  private address(address: string) {
    const label = this.placeholder("address", address);
    // So does the street line of a full address ("412 Oak St" of "412 Oak St, Springfield").
    const street = address.split(",")[0].trim();
    if (street.length >= 5 && street !== address) this.known.set(`address:${street.toLowerCase()}`, label);
  }

  text(input: string): string {
    let out = input;
    const values = [...this.known.entries()].map(([key, label]) => [key.slice(key.indexOf(":") + 1), label] as const);
    // Longest first, so a full name is replaced before its first name.
    for (const [value, label] of values.sort((a, b) => b[0].length - a[0].length)) {
      out = out.replace(new RegExp(`(?<!\\w)${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\w)`, "gi"), label);
    }
    return out.replace(PHONE, (m) => this.placeholder("phone", m)).replace(EMAIL, (m) => this.placeholder("email", m));
  }

  deep(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.deep(item));
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.deep(item)]));
    return value;
  }
}

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** An example with its customers' names, addresses, phones, and emails replaced, consistently within it. */
export function redactExample(example: Example): Example {
  const r = new Redactor();
  const collect = (text: string) => {
    const value = parsed(text);
    if (value === undefined) r.collectText(text);
    else r.collect(typeof value === "string" ? parsed(value) : value);
  };
  for (const message of example.messages) {
    if (message.role === "tool") collect(message.content);
    if (message.role === "assistant") for (const call of message.tool_calls ?? []) collect(call.function.arguments);
  }
  const messages = example.messages.map((message): ChatMessage => {
    if (message.role === "system") return message;
    if (message.role === "assistant") {
      return {
        ...message,
        content: message.content === null ? null : r.text(message.content),
        ...(message.tool_calls
          ? {
              tool_calls: message.tool_calls.map((call) => {
                const args = parsed(call.function.arguments);
                return { ...call, function: { ...call.function, arguments: args === undefined ? r.text(call.function.arguments) : JSON.stringify(r.deep(args)) } };
              }),
            }
          : {}),
      };
    }
    if (message.role === "tool") {
      const body = parsed(message.content);
      return { ...message, content: body === undefined ? r.text(message.content) : JSON.stringify(r.deep(body)) };
    }
    return { ...message, content: r.text(message.content) };
  });
  return { ...example, messages };
}

// Formats.

/** Chat-completions fine-tuning JSONL: `messages` with `tool_calls`, and `tools`. Earlier turns carry `weight: 0`. */
export function openaiLine(example: Example): string {
  return JSON.stringify({ messages: example.messages, tools: example.tools });
}

const header = (role: string) => `<|start_header_id|>${role}<|end_header_id|>\n\n`;
/** Text with anything shaped like a Llama special token broken up, so no message can open or close a turn. */
const plainText = (text: string) => text.replace(/<\|([a-z_]+)\|>/gi, "<\u200b|$1|>");

/** One message in the Llama 3.x chat template. A tool call is its JSON (`{"name", "parameters"}`), one per line. */
function llamaTurn(message: ChatMessage): string {
  switch (message.role) {
    case "system":
    case "user":
      return `${header(message.role)}${plainText(message.content)}<|eot_id|>`;
    case "tool":
      return `${header("ipython")}${plainText(message.content)}<|eot_id|>`;
    case "assistant": {
      const calls = (message.tool_calls ?? []).map((call) => JSON.stringify({ name: call.function.name, parameters: parsed(call.function.arguments) ?? {} }));
      const body = [message.content, ...calls].filter(Boolean).join("\n");
      return `${header("assistant")}${plainText(body)}<|eot_id|>`;
    }
  }
}

/** The tool list as the Llama 3.x system prompt gives it: an instruction, then each tool's JSON. */
function llamaTools(tools: ToolSchema[]): string {
  return [
    "Environment: ipython",
    "",
    "You have access to the following functions. To call a function, respond with JSON of the form " +
      '{"name": function name, "parameters": dictionary of argument name and its value}, one call per line. Do not use variables.',
    "",
    ...tools.map((tool) => JSON.stringify(tool)),
  ].join("\n");
}

/**
 * Llama 3.x chat-template text, split where training starts: `prompt` is the system prompt with the
 * tools, the earlier turns, and the member's message, up to the assistant's header; `completion` is the
 * turn's calls, the tool results, and the reply.
 */
export function llamaLine(example: Example): string {
  const [system, ...rest] = example.messages;
  const head = system.role === "system" ? `${header("system")}${plainText(`${llamaTools(example.tools)}\n\n${system.content}`)}<|eot_id|>` : "";
  const history = rest.slice(0, example.turnStart - 1);
  const [user, ...after] = rest.slice(example.turnStart - 1);
  const prompt = `<|begin_of_text|>${head}${history.map(llamaTurn).join("")}${llamaTurn(user)}${header("assistant")}`;
  const completion = after
    .map(llamaTurn)
    .join("")
    .replace(/^<\|start_header_id\|>assistant<\|end_header_id\|>\n\n/, "");
  return JSON.stringify({ prompt, completion });
}

export type Format = "openai" | "llama";
export const FORMATS: readonly Format[] = ["openai", "llama"];

export function formatLine(example: Example, format: Format): string {
  return format === "llama" ? llamaLine(example) : openaiLine(example);
}

/** An example's sidecar line (`<out>.meta.jsonl`, same order): where it came from and its labels, plus `extra`. */
export function metaLine(example: Example, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...example.meta, ...extra });
}

/** `--labels` as given: a comma list of labels, or `all`. Null for every label; throws on an unknown one. */
export function parseLabels(value: string | undefined): readonly TurnLabel[] | null {
  if (value === undefined) return DEFAULT_LABELS;
  if (value.trim() === "all") return null;
  const labels = value.split(",").map((l) => l.trim()).filter(Boolean);
  const unknown = labels.filter((l) => !(LABELS as readonly string[]).includes(l));
  if (unknown.length) throw new Error(`Unknown label ${unknown.join(", ")}. Labels: ${LABELS.join(", ")}, or all.`);
  return labels as TurnLabel[];
}

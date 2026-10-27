// What the assistant did, under each of its replies in the web chat (components/assistant/assistant-chat.tsx):
// the steps it took, repeats merged, a card for a quote it made, changed, approved, or read, and links from
// the records its tools returned to their pages. A quote touched again later in the conversation shows its
// card only there, on the latest reply about it.

/** A tool call as it sits in an eve message's parts. */
export type ToolCallPart = {
  type: "dynamic-tool";
  toolName: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
};

type MessageLike<P extends { type: string } = { type: string }> = {
  id: string;
  role: string;
  parts: ReadonlyArray<P>;
  metadata?: { turnId?: string };
};

/** Tools that aren't news to the member: the assistant's own housekeeping, and the threads shown as links. */
export const HIDDEN_TOOLS = new Set([
  "read_business",
  "eve__skill",
  "no_reply",
  "react",
  "eve__task_wait",
  "eve__task_cancel",
  // Their names before eve 0.79, in conversations recorded then.
  "load_skill",
  "task_wait",
  "task_cancel",
  "start_job",
  "continue_job",
  "close_job",
]);

/** Tools about one quote: the reply that ran one gets that quote's card. */
export const QUOTE_TOOLS = new Set(["create_quote", "revise_quote", "approve_quote", "set_quote_outcome", "get_quote", "price_photo"]);

/** One step: a tool, how many times it ran, whether it failed, and what it touched ("INV-0003", "3 invoices"). */
export type ToolChip = { tool: string; count: number; failed: boolean; detail: string | null };

const FINISHED = new Set(["output-available", "output-error", "output-denied"]);

function toolCalls(parts: ReadonlyArray<{ type: string }>): ToolCallPart[] {
  return parts.filter((part): part is ToolCallPart => part.type === "dynamic-tool" && FINISHED.has((part as ToolCallPart).state));
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** A call that didn't do what it set out to: it errored, was declined, or its tool refused (`{ error }`). */
export function failedCall(part: ToolCallPart): boolean {
  if (part.state === "output-error" || part.state === "output-denied") return true;
  return typeof record(part.output)?.error === "string";
}

/** One chip per tool (and per outcome), in the order they first ran, with how many times. */
export function toolChipsOf(parts: ReadonlyArray<{ type: string }>): ToolChip[] {
  const chips: ToolChip[] = [];
  for (const part of toolCalls(parts)) {
    if (HIDDEN_TOOLS.has(part.toolName)) continue;
    const failed = failedCall(part);
    const same = chips.find((chip) => chip.tool === part.toolName && chip.failed === failed);
    if (same) same.count += 1;
    else chips.push({ tool: part.toolName, count: 1, failed, detail: failed ? null : detailOf(part.output) });
  }
  return chips;
}

/** The quote a quote tool's call was about: from what it returned, else what it was asked. Null for a failed call. */
export function quoteIdOf(part: ToolCallPart): string | null {
  if (!QUOTE_TOOLS.has(part.toolName) || failedCall(part)) return null;
  const output = record(part.output);
  const fromOutput = output?.quoteId ?? record(output?.quote)?.quoteId;
  if (typeof fromOutput === "string" && fromOutput) return fromOutput;
  const fromInput = record(part.input)?.quoteId;
  return typeof fromInput === "string" && fromInput ? fromInput : null;
}

// ---------------------------------------------------------------------------------------------
// Records the tools returned, and the reply's words linked to them

export type RecordKind = "visit" | "invoice" | "quote" | "customer" | "thread" | "work";
/** A record and the words that name it. `earlier` is one an earlier reply's tools returned. */
export type RecordLink = { text: string; href: string; kind: RecordKind; earlier?: boolean };

const str = (value: unknown, prefix?: string): string | null =>
  typeof value === "string" && value.trim() && (!prefix || value.startsWith(prefix)) ? value.trim() : null;

/** The record one object in a tool's output is, as the words that name it and its page; null for anything else. */
function linkOf(o: Record<string, unknown>): RecordLink | null {
  const visitId = str(o.visitId, "vis_");
  const date = str(o.date);
  const invoiceId = str(o.invoiceId, "inv_");
  const quoteId = str(o.quoteId, "quo_");
  const jobId = str(o.jobId, "job_");
  const workId = str(o.jobId, "sj_");
  const id = str(o.id);
  if (visitId && date && str(o.title)) return { text: str(o.title)!, href: `/schedule?view=day&date=${encodeURIComponent(date)}&visit=${encodeURIComponent(visitId)}`, kind: "visit" };
  if (invoiceId && str(o.label)) return { text: str(o.label)!, href: `/invoices/${encodeURIComponent(invoiceId)}`, kind: "invoice" };
  if (quoteId && str(o.title) && !visitId && !invoiceId) return { text: str(o.title)!, href: `/quotes/${encodeURIComponent(quoteId)}`, kind: "quote" };
  if (id?.startsWith("cus_") && str(o.name)) return { text: str(o.name)!, href: `/customers/${encodeURIComponent(id)}`, kind: "customer" };
  if (jobId && str(o.title) && !quoteId) return { text: str(o.title)!, href: `/threads/${encodeURIComponent(jobId)}`, kind: "thread" };
  if (workId && str(o.title) && !quoteId && !invoiceId) return { text: str(o.title)!, href: `/work/${encodeURIComponent(workId)}`, kind: "work" };
  return null;
}

/** A customer named on another record ("customerName" beside a "customerId"). */
function customerOf(o: Record<string, unknown>): RecordLink | null {
  const customerId = str(o.customerId, "cus_");
  const name = str(o.customerName);
  return customerId && name ? { text: name, href: `/customers/${encodeURIComponent(customerId)}`, kind: "customer" } : null;
}

function walk(value: unknown, visit: (o: Record<string, unknown>) => void, depth = 0): void {
  if (depth > 6 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) walk(item, visit, depth + 1);
    return;
  }
  const o = value as Record<string, unknown>;
  visit(o);
  for (const child of Object.values(o)) walk(child, visit, depth + 1);
}

/** The records a reply's tools returned, each once (the first to name it wins), for linking its words. */
export function recordLinksOf(parts: ReadonlyArray<{ type: string }>): RecordLink[] {
  const links = new Map<string, RecordLink>();
  for (const part of toolCalls(parts)) {
    if (failedCall(part)) continue;
    walk(part.output, (o) => {
      for (const link of [linkOf(o), customerOf(o)]) {
        if (link && link.text.length >= 3 && !/[[\]()`*_]/.test(link.text) && !links.has(link.text)) links.set(link.text, link);
      }
    });
  }
  return [...links.values()];
}

/** What a call touched, in a few words: the one record it returned, or how many. */
function detailOf(output: unknown): string | null {
  const found: string[] = [];
  walk(output, (o) => {
    const link = linkOf(o);
    if (link) found.push(link.text);
  });
  const unique = [...new Set(found)];
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) return `${unique[0]} +${unique.length - 1}`;
  return null;
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches the words however the reply cased and spaced them, with either apostrophe. */
const looseRe = (text: string) => escapeRe(text).replace(/\s+/g, "\\s+").replace(/['’]/g, "['’]");

/**
 * The other ways a reply names a record: an invoice number without its zeros ("INV-7"), a title up to its
 * first comma or dash ("1 Example St" for "1 Example St, back porch"), and a customer's first name when no
 * other customer of the reply shares it. Only for the reply's own records, not earlier ones.
 */
function aliasesOf(link: RecordLink, links: RecordLink[]): string[] {
  if (link.earlier) return [];
  const invoice = /^INV-0*(\d+)$/i.exec(link.text);
  if (link.kind === "invoice" && invoice) return [`INV[-\\s]?0*${invoice[1]}`];
  if (link.kind === "customer") {
    const first = link.text.split(/\s+/)[0];
    if (first === link.text || first.length < 3 || !/^\p{L}/u.test(first)) return [];
    const shared = links.filter((other) => other.kind === "customer" && !other.earlier && other.text.split(/\s+/)[0].toLowerCase() === first.toLowerCase());
    return shared.length === 1 ? [looseRe(first)] : [];
  }
  const head = link.text.split(/\s*(?:,|\s[-–—]\s)/)[0].trim();
  return head !== link.text && head.length >= 5 && /\p{L}/u.test(head) ? [looseRe(head)] : [];
}

/**
 * The reply's Markdown with the first mention of each record linked to its page, matched loosely (any
 * spacing or apostrophe, and any case for the reply's own records) and by its short forms (`aliasesOf`).
 * Whole names go first, longest first, then short forms, so "1 Example St, back porch" wins over
 * "1 Example St". The reply's own records come before earlier ones of the same name. Words already in a
 * link or in code are left alone.
 */
export function linkRecords(markdown: string, links: RecordLink[]): string {
  if (links.length === 0 || !markdown) return markdown;
  const byLength = (a: { text: string }, b: { text: string }) => b.text.length - a.text.length;
  const ordered = [...links].sort((a, b) => Number(!!a.earlier) - Number(!!b.earlier) || byLength(a, b));
  const patterns = [
    ...ordered.map((link) => ({ link, source: looseRe(link.text), text: link.text })),
    ...ordered.flatMap((link) => aliasesOf(link, links).map((source) => ({ link, source, text: source }))).sort(byLength),
  ];
  const pieces = markdown.split(/(\[[^\]]*\]\([^)]*\)|`[^`]*`)/);
  const done = new Set<string>();
  return pieces
    .map((piece, index) => {
      if (index % 2 === 1) return piece;
      const placeholders: string[] = [];
      let out = piece;
      for (const { link, source } of patterns) {
        if (done.has(link.href)) continue;
        const match = new RegExp(`(^|[^\\p{L}\\p{N}_])(${source})(?![\\p{L}\\p{N}_])`, link.earlier ? "u" : "iu").exec(out);
        if (!match) continue;
        done.add(link.href);
        const at = match.index + match[1].length;
        placeholders.push(`[${match[2]}](${link.href})`);
        out = `${out.slice(0, at)}\u0000${placeholders.length - 1}\u0000${out.slice(at + match[2].length)}`;
      }
      return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => placeholders[Number(i)]);
    })
    .join("");
}

/** Exactly the links `linkOf` makes, and nothing else: only these open in place in the chat. */
const RECORD_LINK = /^\/(?:(?:invoices|customers|quotes|threads|work)\/[A-Za-z0-9_-]+|schedule\?view=day&date=\d{4}-\d{2}-\d{2}&visit=vis_[A-Za-z0-9]+)$/;

export function isRecordLink(href: string): boolean {
  return RECORD_LINK.test(href);
}

/**
 * `turnId` is the eve turn the reply ran in (its last message's that names one), and `parts` are every
 * part of the reply's messages, in order: "Under the hood" shows them all.
 */
export type ReplyExtras<P extends { type: string } = { type: string }> = {
  chips: ToolChip[];
  quoteIds: string[];
  links: RecordLink[];
  turnId: string | null;
  parts: P[];
};

/**
 * What goes under each reply. A reply can take several assistant messages in a row (tool calls, then
 * the words), so the run's chips go under its last message, with its quotes' cards. A quote touched in
 * more than one reply shows its card only under the latest, so revising it five times shows one card.
 */
export function replyExtras<P extends { type: string }>(messages: ReadonlyArray<MessageLike<P>>): Map<string, ReplyExtras<P>> {
  const runs: Array<{ lastId: string; turnId: string | null; parts: P[] }> = [];
  let run: { lastId: string; turnId: string | null; parts: P[] } | null = null;
  for (const message of messages) {
    if (message.role !== "assistant") {
      run = null;
      continue;
    }
    if (!run) {
      run = { lastId: message.id, turnId: null, parts: [] };
      runs.push(run);
    }
    run.lastId = message.id;
    run.turnId = message.metadata?.turnId ?? run.turnId;
    run.parts.push(...message.parts);
  }
  const latest = new Map<string, string>();
  for (const { lastId, parts } of runs) {
    for (const part of toolCalls(parts)) {
      const quoteId = quoteIdOf(part);
      if (quoteId) latest.set(quoteId, lastId);
    }
  }
  // A reply often names a record an earlier reply looked up ("Jane's quote is approved"), so each reply
  // links its own records and then, by exact name, the conversation's earlier ones.
  const extras = new Map<string, ReplyExtras<P>>();
  const seen = new Map<string, RecordLink>();
  for (const { lastId, turnId, parts } of runs) {
    const own = recordLinksOf(parts);
    const names = new Set(own.map((link) => link.text));
    const earlier = [...seen.values()].filter((link) => !names.has(link.text)).map((link) => ({ ...link, earlier: true }));
    extras.set(lastId, { chips: toolChipsOf(parts), quoteIds: [], links: [...own, ...earlier], turnId, parts });
    for (const link of own) {
      seen.delete(link.text);
      seen.set(link.text, link);
    }
  }
  for (const [quoteId, messageId] of latest) extras.get(messageId)?.quoteIds.push(quoteId);
  return extras;
}

import { localeFor, type Language } from "@/core/language";
import type { Stage } from "@/components/record/progress-line";

/** "Thu 3:00 PM": a visit's day and time, short enough for a progress line. */
export function shortWhen(at: Date, language: Language, timeZone: string): string {
  return new Intl.DateTimeFormat(localeFor(language), { weekday: "short", hour: "numeric", minute: "2-digit", timeZone }).format(at);
}

type QuoteStatus = "draft" | "needs_owner" | "approved" | "sent" | "won" | "lost" | "void";
type InvoiceStatus = "draft" | "sent" | "partially_paid" | "paid" | "void";

/** Stages from first to last, each reached or not: the furthest reached and all before it are done, the next is current. */
function line(steps: Array<{ label: string; reached: boolean }>): Stage[] {
  const furthest = steps.reduce((at, step, index) => (step.reached ? index : at), -1);
  return steps.map((step, index) => ({ label: step.label, state: index <= furthest ? "done" : index === furthest + 1 ? "current" : "todo" }));
}

/** Stops the line where it ended (a lost or void quote, a void invoice): what was reached, then the end. */
function endedAt(stages: Stage[], label: string): Stage[] {
  return [...stages.filter((s) => s.state === "done"), { label, state: "ended" }];
}

export type QuoteStageLabels = {
  drafted: string;
  approved: string;
  won: string;
  booked: string;
  done: string;
  invoiced: string;
  paid: string;
  lost: string;
  void: string;
};

/**
 * A quote from drafted to paid: approved, won, its work booked (`booked` names the next visit when there
 * is one) and done, then invoiced and paid.
 */
export function quoteProgress(
  input: { status: QuoteStatus; hasVisits: boolean; workDone: boolean; invoice: InvoiceStatus | null; bookedLabel?: string },
  c: QuoteStageLabels,
): Stage[] {
  const invoiced = input.invoice === "sent" || input.invoice === "partially_paid" || input.invoice === "paid";
  // Work booked on an approved quote that was never marked won skips "won" rather than claim it.
  const skipWon = input.status !== "won" && (input.hasVisits || input.workDone || invoiced);
  const stages = line([
    { label: c.drafted, reached: true },
    { label: c.approved, reached: ["approved", "sent", "won"].includes(input.status) },
    ...(skipWon ? [] : [{ label: c.won, reached: input.status === "won" }]),
    { label: input.bookedLabel ?? c.booked, reached: input.hasVisits },
    { label: c.done, reached: input.workDone },
    { label: c.invoiced, reached: invoiced },
    { label: c.paid, reached: input.invoice === "paid" },
  ]);
  if (input.status === "lost") return endedAt(stages, c.lost);
  if (input.status === "void") return endedAt(stages, c.void);
  return stages;
}

/** A piece of work from booked to paid. */
export type WorkStageLabels = { booked: string; done: string; invoiced: string; paid: string; cancelled: string };

export function workProgress(input: { status: "open" | "completed" | "cancelled"; hasVisits: boolean; invoice: InvoiceStatus | null; bookedLabel?: string }, c: WorkStageLabels): Stage[] {
  const stages = line([
    { label: input.bookedLabel ?? c.booked, reached: input.hasVisits },
    { label: c.done, reached: input.status === "completed" },
    { label: c.invoiced, reached: input.invoice === "sent" || input.invoice === "partially_paid" || input.invoice === "paid" },
    { label: c.paid, reached: input.invoice === "paid" },
  ]);
  return input.status === "cancelled" ? endedAt(stages, c.cancelled) : stages;
}

export type InvoiceStageLabels = { draft: string; sent: string; partly: string; paid: string; void: string };

/** An invoice from draft to paid, with "partly paid" between only while it is. */
export function invoiceProgress(status: InvoiceStatus, c: InvoiceStageLabels): Stage[] {
  const stages = line([
    { label: c.draft, reached: true },
    { label: c.sent, reached: status !== "draft" && status !== "void" },
    ...(status === "partially_paid" ? [{ label: c.partly, reached: true }] : []),
    { label: c.paid, reached: status === "paid" },
  ]);
  return status === "void" ? endedAt(stages, c.void) : stages;
}

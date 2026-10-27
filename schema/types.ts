// Shared shapes for jsonb columns and the calculator. This file is the single
// source of truth: core/calculator.ts imports and re-exports these so the
// schema never depends on agent/.

export type UnitKind = "each" | "sqft" | "linear_ft" | "hour" | "visit" | "flat" | "other";

export type LineSource = "pricebook" | "override" | "unpriced";

export interface LineInput {
  itemId: string | null;
  name: string;
  unitLabel: string;
  quantity: number;
  unitCents: number | null;
  taxable: boolean;
  source: LineSource;
}

/** `amount` is cents, cents per unit, or basis points depending on `op`; `appliesTo` lists item ids. */
export interface RuleEffect {
  op: "add_fixed" | "add_per_unit" | "percent";
  amount: number;
  appliesTo: "any" | string[];
}

export interface AppliedRule {
  ruleId: string;
  text: string;
  effect: RuleEffect | null;
}

export interface Adjustment {
  kind: "override" | "discount";
  amountCents: number;
  reason: string;
  memberId: string;
}

export interface LineResult extends LineInput {
  totalCents: number | null;
}

/**
 * An invoice line: a quote line, or one written on the invoice. `unitCents` is null only on a line
 * copied from a quote whose total a price adjustment set.
 */
export type InvoiceLine = LineResult;

export interface RuleLine {
  ruleId: string;
  label: string;
  cents: number;
}

export interface InboundAttachment {
  type: "image" | "file" | "video" | "audio";
  url: string;
  name?: string;
  mimeType?: string;
  /** Set aside as a document (a price list, a customer list), so it never attaches to a quote. */
  document?: boolean;
}

/** A file kept on a document note: one a member texted in. */
export interface NoteFile {
  url: string;
  name?: string;
  mimeType?: string;
  type?: InboundAttachment["type"];
}

/**
 * One stretch of working time in a week, in the business's time zone: `day` is 0 (Sunday) to 6
 * (Saturday), and `start` and `end` are 24-hour `HH:MM` on that day, `end` after `start`.
 */
export interface WorkingInterval {
  day: number;
  start: string;
  end: string;
}

/**
 * What earlier tries at one inbound delivery already did, so a retry picks up after them: whether it
 * was the phone's first contact, whether the welcome and any fixed reply went out, and when it was
 * handed to eve (an ISO time; null once a hand-off is known to have failed).
 */
export interface DeliveryProgress {
  firstContact?: boolean;
  welcomed?: boolean;
  replied?: boolean;
  dispatchStartedAt?: string | null;
  /** Held back by the business's usage limits: the inbound row is this delivery's own, and a later try resumes. */
  held?: boolean;
}

/**
 * One entry in a turn's trace (`turn_traces.steps`), from one eve stream event: a model step starting
 * or completing, a tool call or its result, the model's reasoning, or a message it wrote. `eventId` is
 * the event's id, so a re-delivered event is appended once. Inputs and outputs are stored as they were,
 * cut to 32 KB of JSON with `truncated` set.
 */
export type TraceStep = {
  eventId: string;
  at: string;
  stepIndex: number | null;
  kind: "step" | "tool.call" | "tool.result" | "reasoning" | "message";
  toolName?: string;
  callId?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  status?: string;
  text?: string;
  modelId?: string;
  usage?: Record<string, number>;
  finishReason?: string;
  truncated?: boolean;
};

/** A turn's token and cost totals, summed over its steps. */
export type TraceUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
};

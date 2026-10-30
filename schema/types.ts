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

/** A box in a priced photo's pixels, `right` and `bottom` exclusive. */
export type PricedBox = { left: number; top: number; right: number; bottom: number };

/** One object SAM found in the photo, kept whether or not a line uses it. svgPath is the mask outline in image pixel coordinates. */
export type PricedCandidate = { id: string; phrase: string; box: PricedBox; areaPx: number; confidence: number | null; svgPath: string };

/**
 * One quote line on a priced photo (`priced_photos.regions`): the line as quoted, the noun phrase it was
 * looked for by, and the objects kept for it. Boxes are in the priced photo's pixels, `right` and `bottom`
 * exclusive. A line with no phrase or no object kept has `located: false` and stays on the legend. Each
 * object names the candidate it is (null only on photos made before candidates were kept).
 */
export type PricedRegion = {
  lineIndex: number;
  itemId: string | null;
  name: string;
  quantity: number;
  unitLabel: string;
  totalCents: number | null;
  phrase: string | null;
  objects: Array<{ candidateId: string | null; box: PricedBox; areaPx: number; confidence: number | null }>;
  located: boolean;
};

/**
 * What the quote page's priced photo editor works from. `width` and `height` are the photo's pixels, which
 * the candidates' boxes and outlines are in; `photoUrl` is the original photo and `renderedUrl` the priced
 * one, both served to the signed-in member. `regions` is one per quote line, in line order; `editedBy` is
 * the member's name.
 */
export type PricedPhotoEditorState = {
  pricedPhotoId: string;
  width: number;
  height: number;
  photoUrl: string;
  renderedUrl: string;
  candidates: PricedCandidate[];
  regions: PricedRegion[];
  lines: Array<{ lineIndex: number; name: string; quantity: number; unitLabel: string; totalCents: number | null; phrase: string | null }>;
  editedAt: string | null;
  editedBy: string | null;
};

/**
 * How a job's visits repeat (`core/recurrence.ts`): every week, every two weeks, or every month (on the same weekday
 * of the month, the 2nd Tuesday), on `weekday` (0 Sunday to 6) at `time` (local 24-hour `HH:MM`) for
 * `durationMinutes`. What isn't given comes from its first visit.
 */
export interface Recurrence {
  every: "week" | "two_weeks" | "month";
  weekday?: number;
  time?: string;
  durationMinutes?: number;
}

/**
 * One stop a proposal moves (`core/proposals.ts`): the visit at the revision it was proposed on, where it was
 * and where it would go (instants as ISO strings, the new local day and clock), and the drafts: a text for the
 * customer, which the owner forwards, and the line the receiving crew will be told. `id` is its number in the
 * owner's text ("1", "2").
 */
export type ProposalItem = {
  id: string;
  visitId: string;
  revision: number;
  title: string;
  customerName: string | null;
  from: { startAt: string; endAt: string; memberIds: string[] };
  /** The new local day and clock (`offsetMinutes` settles a clock the fall-back hour repeats), and its buffers: the drives around it. */
  to: {
    startAt: string;
    endAt: string;
    date: string;
    time: string;
    offsetMinutes: number;
    memberIds: string[];
    names: string[];
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
  };
  customerText: string;
  crewText: string;
};

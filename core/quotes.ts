// The quotes service the agent's tools call. Every number comes from `calculate`; this file
// only gathers inputs, stores immutable revisions, and moves a quote through its statuses.
import { and, asc, desc, eq, gte, inArray, isNull, lte, max, or, sql, type SQL } from "drizzle-orm";
import {
  approvals,
  followups,
  members,
  memberPhones,
  messages,
  ownerRequests,
  pricebookItems,
  properties,
  quoteAttachments,
  quoteRevisions,
  quotes,
  rules,
  customers,
  events,
  workPhotos,
} from "../schema/schema";
import { deleteBlob, readStoredFile, storeQuotePdf } from "./blob";
import {
  calculate,
  type Adjustment,
  type AppliedRule,
  type LineInput,
  type LineResult,
  type RuleLine,
} from "./calculator";
import { addressKey, getCustomer, saveCustomer, type CustomerWithProperties } from "./customers";
import { db, newId, type Db, type Tx } from "./db";
import { recordEvent } from "./events";
import { cancelFollowups, cancelNotices, computeDueAt, queueNotice, scheduleFollowup } from "./followups";
import { isLanguage, type Language } from "./language";
import { isPrivileged, privilegedMembers, findMemberById, type Caller, type Role } from "./members";
import { formatCents } from "./money";
import { loadLogo } from "./branding";
import { pdfFileName, renderQuotePdf, type QuotePdfPhoto } from "./pdf";
import { getProfileWith } from "./profile";
import { customerLinkFor, LINKABLE_STATUSES, quoteLinkUrl } from "./quote-link";
import { addDays, todayYmd } from "./time";

export type Quote = typeof quotes.$inferSelect;
type QuoteStatus = Quote["status"];

export type ToolLine = {
  itemId?: string;
  name?: string;
  unitLabel?: string;
  quantity: number;
  unitCents?: number;
};
export type ToolAdjustment = { kind: "override" | "discount"; amountCents: number; reason: string };

/** A customer find_customer didn't find, in the member's words. */
export type NewCustomer = { name: string; phone?: string; email?: string; address?: string; language?: Language };

export interface CreateQuoteInput {
  title: string;
  customerId?: string;
  propertyId?: string;
  /** Saved first, when there is no customerId, and the quote is theirs (at the address, when given). */
  customer?: NewCustomer;
  lines: ToolLine[];
  ruleIds?: string[];
  adjustments?: ToolAdjustment[];
  customerLanguage?: Language;
  customerNotes?: string;
  privateNotes?: string;
}
export interface ReviseQuoteInput extends Partial<CreateQuoteInput> {
  quoteId: string;
  /** Attachment ids (from getQuote) to take off the quote and its PDF. */
  removePhotoIds?: string[];
}

export interface QuoteSummary {
  quoteId: string;
  title: string;
  status: QuoteStatus;
  revisionNumber: number;
  state: "ready" | "needs_owner";
  reasons: string[];
  totalCents: number;
  lines: LineResult[];
  ruleLines: RuleLine[];
  minimumAppliedCents: number;
  adjustmentCents: number;
  taxCents: number;
  pdfUrl: string | null;
  customerId: string | null;
  customerName: string | null;
  propertyAddress: string | null;
  createdBy: string;
  updatedAt: Date;
  /** The customer's link to see and approve it (/q/<token>), once the business signed off and the link was made. */
  customerLink: string | null;
  /** Who approved it on that link, and when. */
  customerApproval: { name: string; at: Date } | null;
  /** The deposit asked when the customer approved it, in cents. */
  depositCents: number | null;
}

export interface QuoteDetail extends QuoteSummary {
  revisions: Array<{ number: number; totalCents: number; createdAt: Date; createdBy: string }>;
  /** Photos and files on the quote, oldest first; the first eight JPEG or PNG photos print on the PDF. */
  attachments: Array<{ id: string; url: string; name: string | null; description: string | null }>;
  customer: CustomerWithProperties | null;
  /** The current revision's language: its PDF and customer link are in it. */
  customerLanguage: Language;
  /** The current revision's notes printed for the customer. */
  customerNotes: string | null;
}

export type Poster = (
  orgId: string,
  memberId: string,
  payload: {
    text?: string;
    file?: { filename: string; mimeType: string; data: Buffer };
    /** Where the file is stored, logged with its post so the web thread can link it. */
    fileUrl?: string;
    quoteId?: string;
    /** The post asks the member to approve `quoteId`, so a 👍 on it can mean "ok". */
    asksApproval?: boolean;
  },
  kind: "proactive" | "system",
) => Promise<{ posted: boolean; reason?: string }>;

type Deps = { post?: Poster; now?: Date };
type ApproveDeps = Deps & { messageId?: string };

const OPEN_STATUSES: QuoteStatus[] = ["draft", "needs_owner"];
const CANDIDATE_WINDOW_DAYS = 7;
const PENDING_LIMIT = 3;
const LIST_DEFAULT_LIMIT = 20;
// The Quotes page asks for one past a page of 50, to know whether there is another.
const LIST_MAX_LIMIT = 51;

// ---------------------------------------------------------------------------------------------
// Posting

/** The real transport lives in outbound.ts (Task 8); resolved lazily so build order never matters. */
const defaultPost: Poster = async (orgId, memberId, payload, kind) => {
  const { postToMember } = await import("./outbound");
  return postToMember(orgId, memberId, payload, kind);
};

/**
 * A proactive notice about a quote. When quiet hours hold it back, it is queued for the morning.
 * Returns whether it went out now, was queued, or neither.
 */
async function postNotice(
  deps: Deps | undefined,
  orgId: string,
  memberId: string,
  payload: { text: string; quoteId: string; asksApproval: boolean },
): Promise<"posted" | "queued" | "failed"> {
  const result = await safePost(deps, orgId, memberId, payload, "proactive");
  if (result.posted) return "posted";
  if (result.reason !== "quiet_hours") return "failed";
  try {
    const { quoteId, ...notice } = payload;
    await queueNotice({ orgId, memberId, quoteId, payload: notice, now: deps?.now ?? new Date() });
    return "queued";
  } catch (error) {
    console.error("quotes: notice could not be queued", error);
    return "failed";
  }
}

/** A failed post never fails the save or the approval. */
async function safePost(
  deps: Deps | undefined,
  orgId: string,
  memberId: string,
  payload: Parameters<Poster>[2],
  kind: Parameters<Poster>[3],
): Promise<{ posted: boolean; reason?: string }> {
  try {
    return await (deps?.post ?? defaultPost)(orgId, memberId, payload, kind);
  } catch (error) {
    console.error("quotes: post failed", error);
    return { posted: false, reason: "error" };
  }
}

// ---------------------------------------------------------------------------------------------
// Summaries

/** Callers add `eq(quotes.orgId, orgId)` to their WHERE; the joined rows hang off the scoped quote. */
function summaryQuery(executor: Db | Tx) {
  return executor
    .select({
      quote: quotes,
      revision: quoteRevisions,
      customerName: customers.name,
      address: properties.address,
      createdByName: members.name,
    })
    .from(quotes)
    .innerJoin(quoteRevisions, eq(quoteRevisions.id, quotes.currentRevisionId))
    .leftJoin(customers, eq(customers.id, quotes.customerId))
    .leftJoin(properties, eq(properties.id, quotes.propertyId))
    .innerJoin(members, eq(members.id, quotes.createdByMemberId));
}

type SummaryRow = Awaited<ReturnType<typeof summaryQuery>>[number];

function toSummary(row: SummaryRow): QuoteSummary {
  const { quote, revision } = row;
  return {
    quoteId: quote.id,
    title: quote.title,
    status: quote.status,
    revisionNumber: revision.number,
    state: revision.state === "ready" ? "ready" : "needs_owner",
    reasons: revision.reasons,
    totalCents: revision.totalCents,
    lines: revision.lines,
    ruleLines: revision.ruleLines,
    minimumAppliedCents: revision.minimumAppliedCents,
    adjustmentCents: revision.adjustmentCents,
    taxCents: revision.taxCents,
    pdfUrl: revision.pdfUrl,
    customerId: quote.customerId,
    customerName: row.customerName,
    propertyAddress: row.address,
    createdBy: row.createdByName,
    updatedAt: quote.updatedAt,
    customerLink: quote.customerToken && LINKABLE_STATUSES.includes(quote.status) ? quoteLinkUrl(quote.customerToken) : null,
    customerApproval: quote.customerApprovedAt && quote.customerApprovedName ? { name: quote.customerApprovedName, at: quote.customerApprovedAt } : null,
    depositCents: quote.depositCents,
  };
}

export async function loadSummary(orgId: string, quoteId: string, executor: Db | Tx = db()): Promise<QuoteSummary> {
  const [row] = await summaryQuery(executor).where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId)));
  if (!row) throw new Error("QUOTE_NOT_FOUND");
  return toSummary(row);
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Where a page of the quotes list starts or ends: one quote's last change (to the millisecond) and id. */
export type QuoteCursor = { at: string; id: string };

/** The cursor for a quote, as the Quotes page passes it back to list the page after or before it. */
export const quoteCursor = (quote: Pick<QuoteSummary, "updatedAt" | "quoteId">): QuoteCursor => ({
  at: quote.updatedAt.toISOString(),
  id: quote.quoteId,
});

// Quotes list by their last change, then id. Changes are kept to the microsecond but a cursor carries
// milliseconds, so both sides compare at milliseconds.
const quoteKey = sql`(date_trunc('milliseconds', ${quotes.updatedAt}), ${quotes.id})`;
const quoteCursorKey = (cursor: QuoteCursor) => sql`(${cursor.at}::timestamptz, ${cursor.id})`;

type QuoteFilter = {
  status?: QuoteStatus[];
  query?: string;
  /** Only quotes this member created. */
  createdByMemberId?: string;
  customerId?: string;
  /** Page by a quote's cursor (keyset, so pages never overlap or skip): older than `before`, newer than `after`. */
  before?: QuoteCursor;
  after?: QuoteCursor;
};

function quoteConditions(orgId: string, filter: QuoteFilter): SQL[] {
  const conditions: SQL[] = [eq(quotes.orgId, orgId)];
  if (filter.status?.length) conditions.push(inArray(quotes.status, filter.status));
  if (filter.createdByMemberId) conditions.push(eq(quotes.createdByMemberId, filter.createdByMemberId));
  if (filter.customerId) conditions.push(eq(quotes.customerId, filter.customerId));
  if (filter.before) conditions.push(sql`${quoteKey} < ${quoteCursorKey(filter.before)}`);
  if (filter.after) conditions.push(sql`${quoteKey} > ${quoteCursorKey(filter.after)}`);
  for (const token of (filter.query ?? "").trim().split(/\s+/).filter(Boolean)) {
    const pattern = `%${escapeLike(token)}%`;
    conditions.push(
      or(
        sql`${quotes.title} ilike ${pattern}`,
        sql`${customers.name} ilike ${pattern}`,
        sql`${properties.address} ilike ${pattern}`,
      ) as SQL,
    );
  }
  return conditions;
}

/**
 * The business's quotes, most recently changed first. With `after`, the ones just newer than it, still
 * newest first.
 */
export async function listQuotes(orgId: string, filter: QuoteFilter & { limit?: number }): Promise<QuoteSummary[]> {
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? LIST_DEFAULT_LIMIT), 1), LIST_MAX_LIMIT);
  const newer = filter.after !== undefined && filter.before === undefined;
  const order = newer
    ? [sql`date_trunc('milliseconds', ${quotes.updatedAt}) asc`, asc(quotes.id)]
    : [sql`date_trunc('milliseconds', ${quotes.updatedAt}) desc`, desc(quotes.id)];
  const rows = await summaryQuery(db())
    .where(and(...quoteConditions(orgId, filter)))
    .orderBy(...order)
    .limit(limit);
  const summaries = rows.map(toSummary);
  return newer ? summaries.reverse() : summaries;
}

/** How many quotes match, for the Quotes page's "51–100 of 230" (with `after`, how many come before a page). */
export async function countQuotes(orgId: string, filter: QuoteFilter): Promise<number> {
  const [row] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(quotes)
    .leftJoin(customers, eq(customers.id, quotes.customerId))
    .leftJoin(properties, eq(properties.id, quotes.propertyId))
    .where(and(...quoteConditions(orgId, filter)));
  return row?.count ?? 0;
}

/** How many quotes have each status, optionally only this member's. */
export async function countQuotesByStatus(
  orgId: string,
  filter: { createdByMemberId?: string } = {},
): Promise<Partial<Record<QuoteStatus, number>>> {
  const rows = await db()
    .select({ status: quotes.status, count: sql<number>`count(*)::int` })
    .from(quotes)
    .where(
      and(
        eq(quotes.orgId, orgId),
        filter.createdByMemberId ? eq(quotes.createdByMemberId, filter.createdByMemberId) : undefined,
      ),
    )
    .groupBy(quotes.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

/** The member who started the quote, or null when it isn't this business's. */
export async function quoteCreatorId(orgId: string, quoteId: string): Promise<string | null> {
  const [row] = await db()
    .select({ memberId: quotes.createdByMemberId })
    .from(quotes)
    .where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId)));
  return row?.memberId ?? null;
}

export async function getQuote(orgId: string, quoteId: string): Promise<QuoteDetail | null> {
  const [row] = await summaryQuery(db()).where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId)));
  if (!row) return null;
  const revisionRows = await db()
    .select({ revision: quoteRevisions, createdBy: members.name })
    .from(quoteRevisions)
    .innerJoin(members, eq(members.id, quoteRevisions.createdByMemberId))
    .where(and(eq(quoteRevisions.orgId, orgId), eq(quoteRevisions.quoteId, quoteId)))
    .orderBy(desc(quoteRevisions.number));
  const attachmentRows = await db()
    .select()
    .from(quoteAttachments)
    .where(and(eq(quoteAttachments.orgId, orgId), eq(quoteAttachments.quoteId, quoteId), isNull(quoteAttachments.removedAt)))
    .orderBy(asc(quoteAttachments.createdAt), asc(quoteAttachments.id));
  return {
    ...toSummary(row),
    revisions: revisionRows.map(({ revision, createdBy }) => ({
      number: revision.number,
      totalCents: revision.totalCents,
      createdAt: revision.createdAt,
      createdBy,
    })),
    attachments: attachmentRows.map((a) => ({ id: a.id, url: a.url, name: a.name, description: a.description })),
    customer: row.quote.customerId ? await getCustomer(orgId, row.quote.customerId) : null,
    customerLanguage: row.revision.customerLanguage,
    customerNotes: row.revision.customerNotes,
  };
}

// ---------------------------------------------------------------------------------------------
// Summary text (spec 4.2: total, items, rules, next step)

type Copy = {
  quoteFor: (title: string) => string;
  unpriced: string;
  checkQuantity: string;
  minimum: string;
  adjustment: string;
  tax: string;
  stillNeeded: (parts: string) => string;
  stillNeededCrew: (parts: string) => string;
  notPriced: string;
  soFar: (total: string) => string;
  priceFor: (name: string) => string;
  quantityFor: (name: string) => string;
  oneOverride: string;
  positiveTotal: string;
  replyOk: string;
  replyCrew: string;
  approved: (link: string | null) => string;
  sent: string;
  won: (by: string | null) => string;
  lost: string;
  voided: string;
  draftedNotice: (crew: string, total: string, title: string, items: string) => string;
  approvedNotice: (approver: string, title: string, total: string) => string;
  priceBy: (crew: string) => string;
  totalBy: (crew: string) => string;
  caption: (title: string, total: string, revision: number) => string;
  pendingDrafted: (crew: string, total: string, title: string) => string;
  pendingNudge: (title: string) => string;
  pendingDraft: (title: string) => string;
  pendingNeedsOwner: (title: string) => string;
};

const COPY: Record<Language, Copy> = {
  en: {
    quoteFor: (title) => `Quote for ${title}`,
    unpriced: "unpriced",
    checkQuantity: "check quantity",
    minimum: "minimum",
    adjustment: "adjustment",
    tax: "tax",
    stillNeeded: (parts) => `Still needed: ${parts}. Tell me and I'll update it.`,
    stillNeededCrew: (parts) => `Still needed: ${parts}. Tell me if you know it, or I can send it to the owner to fill in.`,
    notPriced: "not priced yet",
    soFar: (total) => `${total} so far`,
    priceFor: (name) => `price for ${name}`,
    quantityFor: (name) => `quantity for ${name}`,
    oneOverride: "just one total override",
    positiveTotal: "a total above zero",
    replyOk: "Reply ok to approve, or tell me what to change.",
    replyCrew: "I can send it to the owner for approval, or tell me what to change.",
    approved: (link) =>
      link ? `Approved. Send the customer this link to approve it and pay any deposit online (it's on the PDF too): ${link}` : "Approved. Forward the PDF when you're ready.",
    sent: "Sent. Tell me when it's won or lost.",
    won: (by) => (by ? `Approved on its link, signed "${by}".` : "Marked won."),
    lost: "Marked lost.",
    voided: "Voided.",
    draftedNotice: (crew, total, title, items) =>
      `${crew} drafted ${total} for ${title} (${items}). Reply ok or 👍 to approve, or ask me about it.`,
    approvedNotice: (approver, title, total) => `${approver} approved ${title} (${total}).`,
    priceBy: (crew) => `(${crew}'s price)`,
    totalBy: (crew) => `(total set by ${crew})`,
    caption: (title, total, revision) =>
      `Quote for ${title}: ${total}${revision > 1 ? ` (revision ${revision})` : ""}`,
    pendingDrafted: (crew, total, title) => `${crew} drafted ${total} for ${title}, waiting on you`,
    pendingNudge: (title) => `${title}: approved, no outcome yet`,
    pendingDraft: (title) => `${title}: draft, not approved yet`,
    pendingNeedsOwner: (title) => `${title}: waiting on the owner`,
  },
  es: {
    quoteFor: (title) => `Cotización para ${title}`,
    unpriced: "sin precio",
    checkQuantity: "revisar cantidad",
    minimum: "mínimo",
    adjustment: "ajuste",
    tax: "impuesto",
    stillNeeded: (parts) => `Falta: ${parts}. Dímelo y lo actualizo.`,
    stillNeededCrew: (parts) => `Falta: ${parts}. Dímelo si lo sabes, o se lo envío al dueño para que lo complete.`,
    notPriced: "sin precio todavía",
    soFar: (total) => `${total} hasta ahora`,
    priceFor: (name) => `precio de ${name}`,
    quantityFor: (name) => `cantidad de ${name}`,
    oneOverride: "un solo total fijo",
    positiveTotal: "un total mayor que cero",
    replyOk: "Responde ok para aprobar, o dime qué cambiar.",
    replyCrew: "Puedo enviarlo al dueño para su aprobación, o dime qué cambiar.",
    approved: (link) =>
      link ? `Aprobada. Mándale al cliente este enlace para aprobarla y pagar el depósito en línea (también está en el PDF): ${link}` : "Aprobada. Reenvía el PDF cuando quieras.",
    sent: "Enviada. Avísame si se gana o se pierde.",
    won: (by) => (by ? `Aprobada en su enlace, firmada "${by}".` : "Marcada como ganada."),
    lost: "Marcada como perdida.",
    voided: "Anulada.",
    draftedNotice: (crew, total, title, items) =>
      `${crew} preparó ${total} para ${title} (${items}). Responde ok o 👍 para aprobar, o pregúntame.`,
    approvedNotice: (approver, title, total) => `${approver} aprobó ${title} (${total}).`,
    priceBy: (crew) => `(precio de ${crew})`,
    totalBy: (crew) => `(total fijado por ${crew})`,
    caption: (title, total, revision) =>
      `Cotización para ${title}: ${total}${revision > 1 ? ` (revisión ${revision})` : ""}`,
    pendingDrafted: (crew, total, title) => `${crew} preparó ${total} para ${title}, espera tu aprobación`,
    pendingNudge: (title) => `${title}: aprobada, sin resultado aún`,
    pendingDraft: (title) => `${title}: borrador, sin aprobar`,
    pendingNeedsOwner: (title) => `${title}: esperando al dueño`,
  },
};

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const money = (cents: number, language: Language) => formatCents(cents, language, { concise: true });
const signedMoney = (cents: number, language: Language) =>
  `${cents < 0 ? "-" : "+"}${money(Math.abs(cents), language)}`;
const quantityText = (quantity: number) => String(Number(quantity.toFixed(2)));

/** One entry per item, joined by `joiner`. `priceBy` names the crew member whose own prices (override lines) to mark. */
function itemsLine(summary: QuoteSummary, language: Language, priceBy?: string, joiner = " · "): string {
  const copy = COPY[language];
  return summary.lines
    .map((line) => {
      const name = oneLine(line.name);
      const head = `${quantityText(line.quantity)} ${name}`;
      const mark = priceBy && line.source === "override" ? ` ${copy.priceBy(priceBy)}` : "";
      if (line.totalCents !== null) {
        // "24 × Window wash @ $10 = $240"; a single unit reads "Window wash $150".
        if (line.quantity === 1) return `${name} ${money(line.totalCents, language)}${mark}`;
        if (line.unitCents === null || Math.round(line.unitCents * line.quantity) !== line.totalCents) {
          return `${head} ${money(line.totalCents, language)}${mark}`;
        }
        const unit = money(line.unitCents, language);
        return `${quantityText(line.quantity)} × ${name} @ ${unit} = ${money(line.totalCents, language)}${mark}`;
      }
      return `${head}, ${line.unitCents === null ? copy.unpriced : copy.checkQuantity}`;
    })
    .join(joiner);
}

function needsLine(summary: QuoteSummary, language: Language, role?: Role): string {
  const copy = COPY[language];
  const parts = summary.reasons.map((reason) => {
    const [code, ...rest] = reason.split(":");
    const name = oneLine(rest.join(":"));
    if (code === "unpriced") return copy.priceFor(name);
    if (code === "bad_quantity") return copy.quantityFor(name);
    if (code === "multiple_overrides") return copy.oneOverride;
    if (code === "negative_total") return copy.positiveTotal;
    return oneLine(reason);
  });
  return role === "member" ? copy.stillNeededCrew(parts.join(", ")) : copy.stillNeeded(parts.join(", "));
}

function nextStepLine(summary: QuoteSummary, language: Language, role?: Role): string {
  const copy = COPY[language];
  switch (summary.status) {
    case "approved":
      return copy.approved(summary.customerLink);
    case "sent":
      return copy.sent;
    case "won":
      return copy.won(summary.customerApproval?.name ?? null);
    case "lost":
      return copy.lost;
    case "void":
      return copy.voided;
    default:
      return summary.state === "needs_owner" ? needsLine(summary, language, role) : role === "member" ? copy.replyCrew : copy.replyOk;
  }
}

/** The text from spec 4.2: total, items, rules/minimum/tax when any, and the next step. */
export function quoteSummaryText(summary: QuoteSummary, language: Language, role?: Role): string {
  const copy = COPY[language];
  const extras = [
    ...summary.ruleLines.map((r) => `${oneLine(r.label)} ${signedMoney(r.cents, language)}`),
    ...(summary.minimumAppliedCents > 0
      ? [`${copy.minimum} ${signedMoney(summary.minimumAppliedCents, language)}`]
      : []),
    ...(summary.adjustmentCents !== 0
      ? [`${copy.adjustment} ${signedMoney(summary.adjustmentCents, language)}`]
      : []),
    ...(summary.taxCents > 0 ? [`${copy.tax} ${money(summary.taxCents, language)}`] : []),
  ];
  // An unfinished quote has no total yet: say what's priced so far, never a bare "$0".
  const total =
    summary.state === "ready"
      ? money(summary.totalCents, language)
      : summary.totalCents > 0
        ? copy.soFar(money(summary.totalCents, language))
        : copy.notPriced;
  return [
    `${copy.quoteFor(oneLine(summary.title))}: ${total}`,
    itemsLine(summary, language, undefined, "\n"),
    ...(extras.length ? [extras.join(" · ")] : []),
    nextStepLine(summary, language, role),
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Create and revise

function toLineInput(line: LineResult): LineInput {
  const { totalCents: _totalCents, ...input } = line;
  return input;
}

function resolveLine(line: ToolLine, items: Map<string, typeof pricebookItems.$inferSelect>): LineInput {
  if (typeof line.quantity !== "number" || !Number.isFinite(line.quantity)) throw new Error("INVALID_QUANTITY");
  if (line.unitCents !== undefined && (!Number.isSafeInteger(line.unitCents) || line.unitCents < 0)) {
    throw new Error("INVALID_PRICE");
  }
  if (line.itemId) {
    const item = items.get(line.itemId);
    if (!item) throw new Error(`UNKNOWN_ITEM:${line.itemId}`);
    // An explicit price different from the saved one is a one-time override of that item.
    const overridden = line.unitCents !== undefined && line.unitCents !== item.priceCents;
    return {
      itemId: item.id,
      name: line.name?.trim() || item.name,
      unitLabel: item.unitLabel,
      quantity: line.quantity,
      unitCents: overridden ? (line.unitCents as number) : item.priceCents,
      taxable: item.taxable,
      source: overridden ? "override" : "pricebook",
    };
  }
  const name = line.name?.trim();
  if (!name) throw new Error("LINE_NEEDS_ITEM_OR_NAME");
  return {
    itemId: null,
    name,
    unitLabel: line.unitLabel?.trim() ?? "",
    quantity: line.quantity,
    unitCents: line.unitCents ?? null,
    taxable: true,
    source: line.unitCents === undefined ? "unpriced" : "override",
  };
}

function resolveAdjustments(adjustments: ToolAdjustment[], memberId: string): Adjustment[] {
  return adjustments.map((a) => {
    if (!Number.isSafeInteger(a.amountCents) || a.amountCents < 0) throw new Error("INVALID_ADJUSTMENT");
    return { kind: a.kind, amountCents: a.amountCents, reason: a.reason, memberId };
  });
}

/** Customer and property for a save, checked outside the transaction. */
async function resolveParties(orgId: string, input: Partial<CreateQuoteInput>, existing: Quote | null) {
  let customerId = input.customerId ?? existing?.customerId ?? null;
  let propertyId =
    input.propertyId ??
    (input.customerId && input.customerId !== existing?.customerId ? null : (existing?.propertyId ?? null));
  let customer = customerId ? await getCustomer(orgId, customerId) : null;
  if (customerId && !customer) throw new Error("CUSTOMER_NOT_FOUND");
  if (propertyId) {
    const property = customer?.properties.find((p) => p.id === propertyId);
    if (!property) {
      const [row] = await db()
        .select()
        .from(properties)
        .where(and(eq(properties.orgId, orgId), eq(properties.id, propertyId)));
      if (!row) throw new Error("PROPERTY_NOT_FOUND");
      if (customerId) throw new Error("PROPERTY_MISMATCH");
      customerId = row.customerId;
      customer = await getCustomer(orgId, customerId);
    }
  }
  return { customerId, propertyId, customer };
}

async function saveRevision(args: {
  quoteId: string | null;
  input: Partial<CreateQuoteInput>;
  caller: Caller;
  now: Date;
}): Promise<string> {
  const { input, caller, now } = args;
  const { orgId } = caller;
  let existing: Quote | null = null;
  if (args.quoteId) {
    [existing] = await db().select().from(quotes).where(and(eq(quotes.orgId, orgId), eq(quotes.id, args.quoteId)));
    if (!existing) throw new Error("QUOTE_NOT_FOUND");
  }
  const parties = await resolveParties(orgId, input, existing);

  return db().transaction(async (tx) => {
    let quote: Quote | null = null;
    let previous: typeof quoteRevisions.$inferSelect | null = null;
    if (args.quoteId) {
      [quote] = await tx
        .select()
        .from(quotes)
        .where(and(eq(quotes.orgId, orgId), eq(quotes.id, args.quoteId)))
        .for("update");
      if (!quote) throw new Error("QUOTE_NOT_FOUND");
      if (quote.status === "void" || quote.status === "won" || quote.status === "lost") {
        throw new Error("QUOTE_CLOSED");
      }
      [previous] = await tx
        .select()
        .from(quoteRevisions)
        .where(and(eq(quoteRevisions.orgId, orgId), eq(quoteRevisions.id, quote.currentRevisionId ?? "")));
    }

    const title = (input.title ?? quote?.title ?? "").trim();
    if (!title) throw new Error("TITLE_REQUIRED");
    const profile = await getProfileWith(orgId, tx);

    // Lines: new ones are resolved against the pricebook; otherwise the previous snapshot carries over.
    let lines: LineInput[];
    if (input.lines) {
      const itemIds = [...new Set(input.lines.map((l) => l.itemId).filter((id): id is string => Boolean(id)))];
      const rows = itemIds.length
        ? await tx
            .select()
            .from(pricebookItems)
            .where(
              and(eq(pricebookItems.orgId, orgId), inArray(pricebookItems.id, itemIds), eq(pricebookItems.status, "active")),
            )
        : [];
      const items = new Map(rows.map((r) => [r.id, r]));
      lines = input.lines.map((line) => resolveLine(line, items));
    } else {
      lines = (previous?.lines ?? []).map(toLineInput);
    }
    if (lines.length === 0) throw new Error("NO_LINES");

    // Rules: explicit ids must be active; ids inherited from the previous revision drop out once retired.
    const explicitRules = input.ruleIds !== undefined;
    const ruleIds = [...new Set(explicitRules ? input.ruleIds : (previous?.ruleIds ?? []))];
    const ruleRows = ruleIds.length
      ? await tx.select().from(rules).where(and(eq(rules.orgId, orgId), inArray(rules.id, ruleIds)))
      : [];
    const appliedRules: AppliedRule[] = [];
    for (const id of ruleIds) {
      const row = ruleRows.find((r) => r.id === id);
      if (!row || row.status !== "active") {
        if (explicitRules) throw new Error(`UNKNOWN_RULE:${id}`);
        continue;
      }
      appliedRules.push({ ruleId: row.id, text: row.text, effect: row.effect });
    }

    const adjustments = input.adjustments
      ? resolveAdjustments(input.adjustments, caller.memberId)
      : (previous?.adjustments ?? []);

    const calc = calculate({
      lines,
      rules: appliedRules,
      minimumCents: profile.minimumChargeCents,
      adjustments,
      taxRateBp: profile.taxRateBp,
    });

    const customerLanguage: Language =
      input.customerLanguage ??
      (!previous || input.customerId ? parties.customer?.language : previous.customerLanguage) ??
      "en";

    const quoteId = quote?.id ?? newId("quo");
    const revisionId = newId("rev");
    const [{ latest }] = await tx
      .select({ latest: max(quoteRevisions.number) })
      .from(quoteRevisions)
      .where(and(eq(quoteRevisions.orgId, orgId), eq(quoteRevisions.quoteId, quoteId)));
    const status: QuoteStatus = calc.state === "needs_owner" ? "needs_owner" : "draft";
    const values = {
      title,
      customerId: parties.customerId,
      propertyId: parties.propertyId,
      status,
      currentRevisionId: revisionId,
      updatedAt: now,
    };
    if (quote) {
      await tx.update(quotes).set(values).where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId)));
      // A new revision must be approved again, so its old approval nudge no longer applies.
      if (quote.status === "approved" || quote.status === "sent") await cancelFollowups(orgId, quoteId, tx);
      // Notices still held by quiet hours describe the old revision.
      else await cancelNotices(orgId, quoteId, tx);
    } else {
      await tx.insert(quotes).values({
        id: quoteId,
        orgId,
        ...values,
        createdByMemberId: caller.memberId,
        createdAt: now,
      });
    }

    await tx.insert(quoteRevisions).values({
      id: revisionId,
      orgId,
      quoteId,
      number: (latest ?? 0) + 1,
      lines: calc.lines,
      ruleLines: calc.ruleLines,
      adjustments,
      ruleIds: appliedRules.map((r) => r.ruleId),
      state: calc.state,
      reasons: calc.reasons,
      linesSubtotalCents: calc.linesSubtotalCents,
      subtotalCents: calc.subtotalCents,
      minimumAppliedCents: calc.minimumAppliedCents,
      adjustmentCents: calc.adjustmentCents,
      preTaxCents: calc.preTaxCents,
      taxableCents: calc.taxableCents,
      taxCents: calc.taxCents,
      totalCents: calc.totalCents,
      taxRateBp: profile.taxRateBp,
      pricebookVersion: profile.pricebookVersion,
      rulesVersion: profile.rulesVersion,
      profileVersion: profile.version,
      calcHash: calc.hash,
      pdfUrl: null,
      validUntil: addDays(todayYmd(profile.timeZone, now), profile.quoteValidityDays),
      customerLanguage,
      customerNotes: input.customerNotes ?? previous?.customerNotes ?? null,
      privateNotes: input.privateNotes ?? previous?.privateNotes ?? null,
      createdByMemberId: caller.memberId,
      createdAt: now,
    });
    // `revision` marks a touch that made a new revision, which the reply in this turn asks to approve.
    await recordEvent(
      { orgId, kind: "quote.touched", refId: quoteId, memberId: caller.memberId, data: { revision: (latest ?? 0) + 1 } },
      tx,
    );
    return quoteId;
  });
}

const PDF_PHOTO_LIMIT = 8;
const PDF_PHOTO_TYPES = new Set(["image/jpeg", "image/jpg", "image/png"]);

/** The quote's attached JPEG and PNG photos, oldest first. One that can't be read is left off the PDF. */
async function quotePhotos(orgId: string, quoteId: string): Promise<QuotePdfPhoto[]> {
  const rows = await db()
    .select({ url: quoteAttachments.url, mimeType: quoteAttachments.mimeType })
    .from(quoteAttachments)
    .where(and(eq(quoteAttachments.orgId, orgId), eq(quoteAttachments.quoteId, quoteId), isNull(quoteAttachments.removedAt)))
    .orderBy(asc(quoteAttachments.createdAt), asc(quoteAttachments.id));
  const images = rows.filter((r) => PDF_PHOTO_TYPES.has((r.mimeType ?? "").toLowerCase())).slice(0, PDF_PHOTO_LIMIT);
  const loaded = await Promise.all(
    images.map(async (r) => {
      try {
        const bytes = await readStoredFile(r.url);
        return bytes ? { bytes, mimeType: r.mimeType! } : null;
      } catch (error) {
        console.warn("quotes: a photo could not be read for the PDF", error);
        return null;
      }
    }),
  );
  return loaded.filter((p): p is QuotePdfPhoto => p !== null);
}

/**
 * Renders and stores the current revision's PDF for the quote's status (a draft carries the DRAFT
 * watermark), then posts it to the caller. Neither step fails the save or the approval.
 */
export type RenderedPdf = {
  quote: Quote;
  revision: typeof quoteRevisions.$inferSelect;
  bytes: Uint8Array;
  pdfUrl: string;
  filename: string;
};

/** Renders the quote's current revision as it stands (DRAFT until approved) and stores it as that revision's PDF. */
export async function renderCurrentPdf(orgId: string, quoteId: string): Promise<RenderedPdf> {
  const [row] = await db()
    .select({ quote: quotes, revision: quoteRevisions })
    .from(quotes)
    .innerJoin(quoteRevisions, eq(quoteRevisions.id, quotes.currentRevisionId))
    .where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId)));
  if (!row) throw new Error("QUOTE_NOT_FOUND");
  const { quote, revision } = row;
  const profile = await getProfileWith(orgId, db());
  const customer = quote.customerId ? await getCustomer(orgId, quote.customerId) : null;
  const property = customer?.properties.find((p) => p.id === quote.propertyId) ?? null;
  const bytes = await renderQuotePdf({
    profile,
    quoteId,
    title: quote.title,
    status: quote.status,
    revision,
    customer: customer ? { name: customer.name, phones: customer.phones, emails: customer.emails } : null,
    property: property ? { address: property.address } : null,
    language: revision.customerLanguage,
    photos: await quotePhotos(orgId, quoteId),
    logo: await loadLogo(orgId),
    // Once the business signs off, the customer can approve it from the PDF too.
    approveUrl: quote.status === "approved" || quote.status === "sent" ? await customerLinkFor(orgId, quoteId) : null,
  });
  const pdfUrl = await storeQuotePdf(quoteId, revision.number, bytes);
  await db()
    .update(quoteRevisions)
    .set({ pdfUrl })
    .where(and(eq(quoteRevisions.orgId, orgId), eq(quoteRevisions.id, revision.id)));
  const filename = pdfFileName(quote.title, revision.number, revision.customerLanguage);
  return { quote, revision: { ...revision, pdfUrl }, bytes, pdfUrl, filename };
}

async function deliverPdf(quoteId: string, caller: Caller, deps: Deps | undefined): Promise<void> {
  const { orgId } = caller;
  // A quote still missing prices or quantities has no PDF worth sending: it would print a partial
  // total. Its summary says what's missing, and the PDF follows once the revision is ready.
  const [current] = await db()
    .select({ state: quoteRevisions.state })
    .from(quotes)
    .innerJoin(quoteRevisions, eq(quoteRevisions.id, quotes.currentRevisionId))
    .where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId)));
  if (current?.state !== "ready") return;
  let rendered: RenderedPdf;
  try {
    rendered = await renderCurrentPdf(orgId, quoteId);
  } catch (error) {
    console.error("quotes: pdf failed", error);
    return;
  }
  const { quote, revision, bytes, pdfUrl, filename } = rendered;

  const lastService = caller.phoneE164
    ? (
        await db()
          .select({ s: memberPhones.lastService })
          .from(memberPhones)
          .where(and(eq(memberPhones.orgId, orgId), eq(memberPhones.e164, caller.phoneE164)))
      )[0]?.s
    : null;
  const textOnly = lastService === "SMS" || lastService === "RCS";
  const asksApproval = OPEN_STATUSES.includes(quote.status);
  const caption = COPY[caller.language].caption(oneLine(quote.title), money(revision.totalCents, caller.language), revision.number);
  if (textOnly) {
    await safePost(deps, orgId, caller.memberId, { text: `${caption}\n${pdfUrl}`, quoteId, asksApproval }, "system");
  } else {
    const file = {
      filename,
      mimeType: "application/pdf",
      data: Buffer.from(bytes),
    };
    // No caption: the file bubble names the quote, and the summary that follows starts with the same line.
    await safePost(deps, orgId, caller.memberId, { file, fileUrl: pdfUrl, quoteId, asksApproval }, "system");
  }
}

/** A photo a member uploaded on the quote's page, already stored (core/blob.ts). */
export type UploadedPhoto = { url: string; name: string | null; mimeType: string };

/**
 * `photosSince` attaches the caller's photos sent since then, and `addPhotos` the ones they uploaded on
 * the quote's page, before the PDF renders, so they print on it.
 */
type SaveDeps = Deps & { photosSince?: Date; addPhotos?: UploadedPhoto[] };

async function attachPhotos(quoteId: string, caller: Caller, since: Date | undefined): Promise<void> {
  if (!since) return;
  try {
    await linkRecentAttachments(caller.orgId, quoteId, caller.memberId, since);
  } catch (error) {
    console.error("quotes: linking photos failed", error);
  }
}

/**
 * Saves `customer` (an address becomes their property) and points the quote at them and that property.
 * A customerId wins: `customer` is then left out.
 */
async function withNewCustomer(input: Partial<CreateQuoteInput>, caller: Caller): Promise<Partial<CreateQuoteInput>> {
  const { customer: stated, ...rest } = input;
  if (!stated || rest.customerId) return rest;
  const saved = await saveCustomer(caller.orgId, stated, caller.memberId);
  const address = stated.address?.trim();
  const property = address ? saved.properties.find((p) => addressKey(p.address) === addressKey(address)) : undefined;
  return { ...rest, customerId: saved.id, propertyId: property?.id };
}

export async function createQuote(input: CreateQuoteInput, caller: Caller, deps?: SaveDeps): Promise<QuoteSummary> {
  const quoteId = await saveRevision({ quoteId: null, input: await withNewCustomer(input, caller), caller, now: deps?.now ?? new Date() });
  await attachPhotos(quoteId, caller, deps?.photosSince);
  await deliverPdf(quoteId, caller, deps);
  return loadSummary(caller.orgId, quoteId);
}

export async function reviseQuote(input: ReviseQuoteInput, caller: Caller, deps?: SaveDeps): Promise<QuoteSummary> {
  const { quoteId: id, removePhotoIds = [], ...changes } = input;
  const { orgId } = caller;
  const now = deps?.now ?? new Date();
  if (removePhotoIds.length > 0) {
    const found = await db()
      .select({ id: quoteAttachments.id })
      .from(quoteAttachments)
      .where(
        and(
          eq(quoteAttachments.orgId, orgId),
          eq(quoteAttachments.quoteId, id),
          inArray(quoteAttachments.id, removePhotoIds),
          isNull(quoteAttachments.removedAt),
        ),
      );
    if (found.length !== new Set(removePhotoIds).size) throw new Error("PHOTO_NOT_FOUND");
  }
  // Crew revise their own open quotes, and anyone's while it's still a draft.
  if (!isPrivileged(caller.role)) {
    const [quote] = await db()
      .select({ createdBy: quotes.createdByMemberId, status: quotes.status })
      .from(quotes)
      .where(and(eq(quotes.orgId, orgId), eq(quotes.id, id)));
    if (quote && quote.createdBy !== caller.memberId && !OPEN_STATUSES.includes(quote.status)) throw new Error("NOT_YOUR_QUOTE");
  }
  const quoteId = await saveRevision({ quoteId: id, input: await withNewCustomer(changes, caller), caller, now });
  if (removePhotoIds.length > 0) {
    await db()
      .update(quoteAttachments)
      .set({ removedAt: now })
      .where(
        and(
          eq(quoteAttachments.orgId, orgId),
          eq(quoteAttachments.quoteId, quoteId),
          inArray(quoteAttachments.id, removePhotoIds),
        ),
      );
  }
  if (deps?.addPhotos?.length) {
    await db()
      .insert(quoteAttachments)
      .values(
        deps.addPhotos.map((photo) => ({
          id: newId("att"),
          orgId,
          quoteId,
          messageId: null,
          uploadedByMemberId: caller.memberId,
          url: photo.url,
          name: photo.name,
          mimeType: photo.mimeType,
          createdAt: now,
        })),
      );
  }
  await attachPhotos(quoteId, caller, deps?.photosSince);
  await deliverPdf(quoteId, caller, deps);
  return loadSummary(orgId, quoteId);
}

// ---------------------------------------------------------------------------------------------
// Approval

export type ApproveResult =
  | { ok: true; quote: QuoteSummary }
  | { ok: false; reason: "not_privileged" | "nothing_to_approve" | "ambiguous"; candidates: QuoteSummary[] }
  /**
   * The quote still needs the owner (unpriced line and so on), a newer revision exists than the one
   * approved, or (`confirm`) this quote was never put to the member, so its summary goes to them first.
   */
  | { ok: false; reason: "not_ready" | "revision_changed" | "confirm"; quote: QuoteSummary };

/** The quote, and its revision, that a message asked the member to approve. */
export type AskedApproval = { quoteId: string; revisionNumber: number | null };

/**
 * The quote the member's message answers, when it answers a request to approve one. A tapback answers
 * the message it is on; a text answers the newest message that asked them, within the candidate window.
 * Null when neither asked them anything.
 */
export async function askedApproval(
  orgId: string,
  memberId: string,
  source: { kind: string; targetProviderMessageId: string | null; createdAt: Date } | null,
  now: Date = new Date(),
): Promise<AskedApproval | null> {
  const asking = [eq(messages.orgId, orgId), eq(messages.memberId, memberId), eq(messages.direction, "outbound"), eq(messages.asksApproval, true)];
  let where: SQL | undefined;
  if (source?.kind === "reaction") {
    if (!source.targetProviderMessageId) return null;
    where = and(...asking, eq(messages.providerMessageId, source.targetProviderMessageId));
  } else {
    const at = source?.createdAt ?? now;
    const since = new Date(at.getTime() - CANDIDATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    where = and(...asking, lte(messages.createdAt, at), gte(messages.createdAt, since));
  }
  const [row] = await db()
    .select({ quoteId: messages.quoteId, createdAt: messages.createdAt })
    .from(messages)
    .where(where)
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  if (!row?.quoteId) return null;
  return { quoteId: row.quoteId, revisionNumber: await revisionNumberAt(orgId, row.quoteId, row.createdAt) };
}

/**
 * `expectedRevisionNumber` pins the revision the approver actually saw (a tapback targets a specific
 * message): if the quote has moved on, nothing is approved and `revision_changed` comes back.
 *
 * `asked` scopes an approval by text to what was put to the member (see `askedApproval`). An open quote
 * they weren't asked about isn't approved: it comes back as `confirm`, marked so the reply carrying its
 * summary asks for approval, and their next ok approves it. Its revision pins the approval like
 * `expectedRevisionNumber`. Leave it undefined where the member can see the quote they approve (on a screen,
 * or "sent it" and "email it", which name the quote themselves).
 */
export async function approveQuote(
  quoteId: string | undefined,
  caller: Caller,
  deps?: ApproveDeps & { expectedRevisionNumber?: number; asked?: AskedApproval | null },
): Promise<ApproveResult> {
  if (!isPrivileged(caller.role)) return { ok: false, reason: "not_privileged", candidates: [] };
  const { orgId } = caller;
  const now = deps?.now ?? new Date();

  let targetId = quoteId;
  if (!targetId) {
    const since = new Date(now.getTime() - CANDIDATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await summaryQuery(db())
      .where(and(eq(quotes.orgId, orgId), inArray(quotes.status, OPEN_STATUSES), gte(quotes.updatedAt, since)))
      .orderBy(desc(quotes.updatedAt), desc(quotes.id));
    const open = rows.map(toSummary);
    // Without an id nothing is approved, not even a lone candidate: the caller must name the quote the
    // member answered. Only quotes that can be approved are candidates; a lone unready one is reported.
    const ready = open.filter((q) => q.state === "ready");
    if (ready.length > 0) return { ok: false, reason: "ambiguous", candidates: ready };
    if (open.length === 1) targetId = open[0].quoteId;
    else return { ok: false, reason: "nothing_to_approve", candidates: [] };
  }

  let expectedRevisionNumber = deps?.expectedRevisionNumber;
  if (deps?.asked !== undefined) {
    if (deps.asked?.quoteId === targetId) {
      expectedRevisionNumber ??= deps.asked.revisionNumber ?? undefined;
    } else {
      const [found] = await db()
        .select({ id: quotes.id })
        .from(quotes)
        .where(and(eq(quotes.orgId, orgId), eq(quotes.id, targetId)));
      if (!found) throw new Error("QUOTE_NOT_FOUND");
      const current = await loadSummary(orgId, targetId);
      // Approved, closed, and unready quotes fall through: none of them can be approved by this anyway.
      if (OPEN_STATUSES.includes(current.status) && current.state === "ready") {
        await recordEvent({
          orgId,
          kind: "quote.touched",
          refId: targetId,
          memberId: caller.memberId,
          data: { revision: current.revisionNumber },
        });
        return { ok: false, reason: "confirm", quote: current };
      }
    }
  }

  const outcome = await db().transaction(async (tx) => {
    const [quote] = await tx
      .select()
      .from(quotes)
      .where(and(eq(quotes.orgId, orgId), eq(quotes.id, targetId)))
      .for("update");
    if (!quote) throw new Error("QUOTE_NOT_FOUND");
    if (!OPEN_STATUSES.includes(quote.status) && quote.status !== "approved" && quote.status !== "sent") {
      return { kind: "closed" as const, quote };
    }
    const [revision] = await tx
      .select()
      .from(quoteRevisions)
      .where(and(eq(quoteRevisions.orgId, orgId), eq(quoteRevisions.id, quote.currentRevisionId ?? "")));
    const touched = () => recordEvent({ orgId, kind: "quote.touched", refId: quote.id, memberId: caller.memberId }, tx);
    if (expectedRevisionNumber !== undefined && expectedRevisionNumber !== revision.number) {
      // The reply re-sends the current revision for approval, so mark it as one a 👍 can approve.
      await recordEvent(
        { orgId, kind: "quote.touched", refId: quote.id, memberId: caller.memberId, data: { revision: revision.number } },
        tx,
      );
      return { kind: "revision_changed" as const, quote };
    }
    // Approving twice (a repeated tapback) changes nothing but the conversation's quote reference.
    if (quote.status === "approved" || quote.status === "sent") {
      await touched();
      return { kind: "unchanged" as const, quote };
    }
    if (revision.state !== "ready") {
      await touched();
      return { kind: "not_ready" as const, quote };
    }
    const profile = await getProfileWith(orgId, tx);

    await tx
      .update(quotes)
      .set({ status: "approved", approvedAt: now, approvedByMemberId: caller.memberId, updatedAt: now })
      .where(and(eq(quotes.orgId, orgId), eq(quotes.id, quote.id)));
    await tx.insert(approvals).values({
      id: newId("apr"),
      orgId,
      quoteRevisionId: revision.id,
      memberId: caller.memberId,
      messageId: deps?.messageId ?? null,
    });
    await tx
      .update(ownerRequests)
      .set({ status: "approved", resolvedAt: now })
      .where(and(eq(ownerRequests.orgId, orgId), eq(ownerRequests.quoteId, quote.id), eq(ownerRequests.status, "pending")));
    await scheduleFollowup(
      {
        orgId,
        quoteId: quote.id,
        memberId: caller.memberId,
        kind: "nudge",
        dueAt: computeDueAt(now, profile.followUpDays, profile),
      },
      tx,
    );
    await recordEvent({ orgId, kind: "quote.touched", refId: quote.id, memberId: caller.memberId }, tx);
    return { kind: "approved" as const, quote };
  });

  if (outcome.kind === "closed") return { ok: false, reason: "nothing_to_approve", candidates: [] };
  if (outcome.kind === "approved") {
    // The customer's link, which the PDF and the summary carry from here on.
    await customerLinkFor(orgId, outcome.quote.id).catch((error) => console.error("quotes: customer link failed", error));
    // The PDF the owner forwards must not say DRAFT: re-render the approved revision and send it to them.
    await deliverPdf(outcome.quote.id, caller, deps);
  }
  const summary = await loadSummary(orgId, outcome.quote.id);
  if (outcome.kind === "revision_changed" || outcome.kind === "not_ready") {
    return { ok: false, reason: outcome.kind, quote: summary };
  }

  if (outcome.kind === "approved" && outcome.quote.createdByMemberId !== caller.memberId) {
    const drafter = await findMemberById(orgId, outcome.quote.createdByMemberId);
    if (drafter && drafter.status === "active") {
      const language = isLanguage(drafter.language) ? drafter.language : "en";
      await postNotice(deps, orgId, drafter.id, {
        text: COPY[language].approvedNotice(caller.name, oneLine(summary.title), money(summary.totalCents, language)),
        quoteId: summary.quoteId,
        asksApproval: false,
      });
    }
  }
  return { ok: true, quote: summary };
}

/**
 * Marks a crew draft as waiting on the owner and texts every owner and admin about it. `notified` are
 * the names texted now; `queued` are those quiet hours held back, who get it when quiet hours end.
 */
export async function requestOwnerApproval(
  quoteId: string,
  caller: Caller,
  deps?: Deps,
): Promise<{ notified: string[]; queued: string[] }> {
  const { orgId } = caller;
  const revision = await db().transaction(async (tx) => {
    const [quote] = await tx
      .select()
      .from(quotes)
      .where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId)))
      .for("update");
    if (!quote) throw new Error("QUOTE_NOT_FOUND");
    if (!OPEN_STATUSES.includes(quote.status)) throw new Error("QUOTE_NOT_OPEN");
    const [current] = await tx
      .select({ createdBy: quoteRevisions.createdByMemberId, adjustments: quoteRevisions.adjustments })
      .from(quoteRevisions)
      .where(and(eq(quoteRevisions.orgId, orgId), eq(quoteRevisions.id, quote.currentRevisionId ?? "")));
    await tx
      .update(quotes)
      .set({ status: "needs_owner", updatedAt: new Date() })
      .where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId)));
    const [pending] = await tx
      .select({ id: ownerRequests.id })
      .from(ownerRequests)
      .where(and(eq(ownerRequests.orgId, orgId), eq(ownerRequests.quoteId, quoteId), eq(ownerRequests.status, "pending")));
    if (!pending) {
      await tx.insert(ownerRequests).values({ id: newId("req"), orgId, quoteId, requestedByMemberId: caller.memberId });
    }
    await recordEvent({ orgId, kind: "quote.touched", refId: quoteId, memberId: caller.memberId }, tx);
    return current;
  });

  const summary = await loadSummary(orgId, quoteId);
  // The owner must see which prices the crew member set rather than the pricebook: their override
  // lines (when they made this revision) and a total override they entered.
  const crewLines = revision?.createdBy === caller.memberId;
  const crewTotal = (revision?.adjustments ?? []).some((a) => a.kind === "override" && a.memberId === caller.memberId);
  const notified: string[] = [];
  const queued: string[] = [];
  for (const member of await privilegedMembers(orgId)) {
    const language = isLanguage(member.language) ? member.language : "en";
    const total = money(summary.totalCents, language);
    const text = COPY[language].draftedNotice(
      caller.name,
      crewTotal ? `${total} ${COPY[language].totalBy(caller.name)}` : total,
      oneLine(summary.title),
      itemsLine(summary, language, crewLines ? caller.name : undefined),
    );
    const result = await postNotice(deps, orgId, member.id, { text, quoteId, asksApproval: true });
    if (result === "posted") notified.push(member.name);
    if (result === "queued") queued.push(member.name);
  }
  return { notified, queued };
}

// ---------------------------------------------------------------------------------------------
// Outcomes

export async function setQuoteOutcome(
  quoteId: string,
  outcome: "sent" | "won" | "lost" | "void",
  caller: Caller,
  deps?: Deps,
): Promise<QuoteSummary> {
  // Crew can draft and mark sent, nothing else.
  if (outcome !== "sent" && !isPrivileged(caller.role)) throw new Error("NOT_PRIVILEGED");
  const { orgId } = caller;
  const now = deps?.now ?? new Date();

  // An owner or admin saying "sent it" about a draft approves it first, the same way approve_quote does.
  if (outcome === "sent" && isPrivileged(caller.role)) {
    const [quote] = await db()
      .select({ status: quotes.status })
      .from(quotes)
      .where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId)));
    if (quote && OPEN_STATUSES.includes(quote.status)) {
      const approved = await approveQuote(quoteId, caller, deps);
      if (!approved.ok) throw new Error(approved.reason === "not_ready" ? "NOT_READY" : "NOT_APPROVED");
    }
  }

  const blobUrl = await db().transaction(async (tx) => {
    const [quote] = await tx
      .select()
      .from(quotes)
      .where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId)))
      .for("update");
    if (!quote) throw new Error("QUOTE_NOT_FOUND");
    if (quote.status === "void") throw new Error("QUOTE_CLOSED");
    if (outcome === "sent" && quote.status !== "approved" && quote.status !== "sent") {
      throw new Error("NOT_APPROVED");
    }
    await tx
      .update(quotes)
      .set({ status: outcome, updatedAt: now, ...(outcome === "sent" ? {} : { outcomeAt: now }) })
      .where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId)));
    if (outcome !== "sent") await cancelFollowups(orgId, quoteId, tx);

    let url: string | null = null;
    if (outcome === "void") {
      await tx
        .update(ownerRequests)
        .set({ status: "declined", resolvedAt: now })
        .where(and(eq(ownerRequests.orgId, orgId), eq(ownerRequests.quoteId, quoteId), eq(ownerRequests.status, "pending")));
      const [revision] = await tx
        .select({ id: quoteRevisions.id, pdfUrl: quoteRevisions.pdfUrl })
        .from(quoteRevisions)
        .where(and(eq(quoteRevisions.orgId, orgId), eq(quoteRevisions.id, quote.currentRevisionId ?? "")));
      url = revision?.pdfUrl ?? null;
      if (revision) {
        await tx
          .update(quoteRevisions)
          .set({ pdfUrl: null })
          .where(and(eq(quoteRevisions.orgId, orgId), eq(quoteRevisions.id, revision.id)));
      }
    }
    // `outcome` puts the change on the quote's timeline in the web app.
    await recordEvent({ orgId, kind: "quote.touched", refId: quoteId, memberId: caller.memberId, data: { outcome } }, tx);
    return url;
  });

  if (blobUrl) {
    try {
      await deleteBlob(blobUrl);
    } catch (error) {
      console.error("quotes: blob delete failed", error);
    }
  }
  return loadSummary(orgId, quoteId);
}

/**
 * Moves the follow-up nudge on an approved or sent quote to `days` from now (out of quiet hours),
 * replacing any pending one. The nudge goes to whoever asked. Throws `QUOTE_NOT_FOUND`,
 * `NOT_APPROVED`, or `INVALID_DAYS`.
 */
export async function setFollowup(
  quoteId: string,
  days: number,
  caller: Caller,
  deps?: { now?: Date },
): Promise<{ dueAt: Date }> {
  if (!Number.isInteger(days) || days < 1 || days > 60) throw new Error("INVALID_DAYS");
  const { orgId } = caller;
  const now = deps?.now ?? new Date();
  return db().transaction(async (tx) => {
    const [quote] = await tx
      .select()
      .from(quotes)
      .where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId)))
      .for("update");
    if (!quote) throw new Error("QUOTE_NOT_FOUND");
    if (quote.status !== "approved" && quote.status !== "sent") throw new Error("NOT_APPROVED");
    const profile = await getProfileWith(orgId, tx);
    const dueAt = computeDueAt(now, days, profile);
    await cancelFollowups(orgId, quoteId, tx);
    await scheduleFollowup({ orgId, quoteId, memberId: caller.memberId, kind: "nudge", dueAt }, tx);
    await recordEvent({ orgId, kind: "quote.touched", refId: quoteId, memberId: caller.memberId }, tx);
    return { dueAt };
  });
}

// ---------------------------------------------------------------------------------------------
// What is waiting on a member

/** At most three one-line items awaiting this member. */
export async function pendingForMember(caller: Caller, deps?: { now?: Date }): Promise<string[]> {
  const { orgId } = caller;
  const now = deps?.now ?? new Date();
  const copy = COPY[caller.language];
  const lines: string[] = [];

  if (isPrivileged(caller.role)) {
    const requests = await db()
      .select({
        title: quotes.title,
        total: quoteRevisions.totalCents,
        crew: members.name,
      })
      .from(ownerRequests)
      .innerJoin(quotes, eq(quotes.id, ownerRequests.quoteId))
      .innerJoin(quoteRevisions, eq(quoteRevisions.id, quotes.currentRevisionId))
      .innerJoin(members, eq(members.id, ownerRequests.requestedByMemberId))
      .where(and(eq(ownerRequests.orgId, orgId), eq(ownerRequests.status, "pending"), inArray(quotes.status, OPEN_STATUSES)))
      .orderBy(asc(ownerRequests.createdAt), asc(ownerRequests.id))
      .limit(PENDING_LIMIT);
    for (const r of requests) {
      lines.push(copy.pendingDrafted(r.crew, money(r.total, caller.language), oneLine(r.title)));
    }
    if (lines.length < PENDING_LIMIT) {
      const nudges = await db()
        .select({ title: quotes.title })
        .from(followups)
        .innerJoin(quotes, eq(quotes.id, followups.quoteId))
        .where(
          and(
            eq(followups.orgId, orgId),
            eq(followups.kind, "nudge"),
            eq(followups.status, "pending"),
            eq(followups.memberId, caller.memberId),
            lte(followups.dueAt, now),
            inArray(quotes.status, ["approved", "sent"]),
          ),
        )
        .orderBy(asc(followups.dueAt), asc(followups.id))
        .limit(PENDING_LIMIT);
      for (const n of nudges) lines.push(copy.pendingNudge(oneLine(n.title)));
    }
  } else {
    const own = await db()
      .select({ title: quotes.title, status: quotes.status })
      .from(quotes)
      .where(and(eq(quotes.orgId, orgId), eq(quotes.createdByMemberId, caller.memberId), inArray(quotes.status, OPEN_STATUSES)))
      .orderBy(desc(quotes.updatedAt), desc(quotes.id))
      .limit(PENDING_LIMIT);
    for (const q of own) {
      lines.push(q.status === "needs_owner" ? copy.pendingNeedsOwner(oneLine(q.title)) : copy.pendingDraft(oneLine(q.title)));
    }
  }
  return lines.slice(0, PENDING_LIMIT);
}

// ---------------------------------------------------------------------------------------------
// Conversation helpers

/** The quote this member most recently created, revised, approved, or closed since `since`. */
export async function recentQuoteRef(orgId: string, memberId: string, since: Date): Promise<string | null> {
  const [row] = await db()
    .select({ refId: events.refId })
    .from(events)
    .where(
      and(eq(events.orgId, orgId), eq(events.kind, "quote.touched"), eq(events.memberId, memberId), gte(events.createdAt, since)),
    )
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(1);
  return row?.refId ?? null;
}

/**
 * The quote this member touched most recently since `since` (the start of their turn), and whether the
 * reply about it asks for approval: it is still open and got a new revision in that time.
 */
export async function turnQuoteRef(
  orgId: string,
  memberId: string,
  since: Date,
): Promise<{ quoteId: string; asksApproval: boolean } | null> {
  const quoteId = await recentQuoteRef(orgId, memberId, since);
  if (!quoteId) return null;
  const [revised] = await db()
    .select({ status: quotes.status })
    .from(events)
    .innerJoin(quotes, and(eq(quotes.orgId, orgId), eq(quotes.id, events.refId)))
    .where(
      and(
        eq(events.orgId, orgId),
        eq(events.kind, "quote.touched"),
        eq(events.memberId, memberId),
        eq(events.refId, quoteId),
        gte(events.createdAt, since),
        sql`${events.data} ? 'revision'`,
      ),
    )
    .limit(1);
  return { quoteId, asksApproval: Boolean(revised && OPEN_STATUSES.includes(revised.status)) };
}

/** The number of the latest revision created at or before `at`, or null when none existed yet. */
export async function revisionNumberAt(orgId: string, quoteId: string, at: Date): Promise<number | null> {
  const [row] = await db()
    .select({ number: max(quoteRevisions.number) })
    .from(quoteRevisions)
    .where(and(eq(quoteRevisions.orgId, orgId), eq(quoteRevisions.quoteId, quoteId), lte(quoteRevisions.createdAt, at)));
  return row?.number ?? null;
}

/**
 * Sets aside the photos and files this member sent since your last reply (and within `windowMs`) as
 * documents, so `linkRecentAttachments` never puts a price list or a customer list on a quote. Ones a
 * quote already has are left alone. Returns how many were set aside.
 */
export async function setAsideRecentAttachments(
  orgId: string,
  memberId: string,
  options: { now?: Date; windowMs: number },
): Promise<number> {
  const now = options.now ?? new Date();
  return db().transaction(async (tx) => {
    const [lastReply] = await tx
      .select({ at: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          eq(messages.memberId, memberId),
          eq(messages.direction, "outbound"),
          eq(messages.kind, "assistant"),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    const windowStart = new Date(now.getTime() - options.windowMs);
    const since = lastReply && lastReply.at > windowStart ? lastReply.at : windowStart;
    const inbound = await tx
      .select({ id: messages.id, attachments: messages.attachments })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          eq(messages.memberId, memberId),
          eq(messages.direction, "inbound"),
          gte(messages.createdAt, since),
          sql`jsonb_array_length(${messages.attachments}) > 0`,
        ),
      );
    if (inbound.length === 0) return 0;
    const linked = await tx
      .select({ messageId: quoteAttachments.messageId, url: quoteAttachments.url })
      .from(quoteAttachments)
      .where(and(eq(quoteAttachments.orgId, orgId), inArray(quoteAttachments.messageId, inbound.map((m) => m.id))));
    const onQuote = new Set(linked.map((l) => `${l.messageId}\n${l.url}`));
    let count = 0;
    for (const message of inbound) {
      const next = message.attachments.map((a) => {
        if (a.document || onQuote.has(`${message.id}\n${a.url}`)) return a;
        count++;
        return { ...a, document: true };
      });
      if (next.some((a, i) => a !== message.attachments[i])) {
        await tx
          .update(messages)
          .set({ attachments: next })
          .where(and(eq(messages.orgId, orgId), eq(messages.id, message.id)));
      }
    }
    return count;
  });
}

/** Attaches this member's inbound attachments since `since` that no quote or work has claimed yet, except documents. */
export async function linkRecentAttachments(orgId: string, quoteId: string, memberId: string, since: Date): Promise<number> {
  return db().transaction(async (tx) => {
    // The quote must be this business's: a photo is never linked across businesses.
    const [quote] = await tx
      .select({ id: quotes.id })
      .from(quotes)
      .where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId)));
    if (!quote) throw new Error("QUOTE_NOT_FOUND");
    const inbound = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          eq(messages.memberId, memberId),
          eq(messages.direction, "inbound"),
          gte(messages.createdAt, since),
          sql`jsonb_array_length(${messages.attachments}) > 0`,
        ),
      )
      .orderBy(asc(messages.createdAt), asc(messages.id));
    if (inbound.length === 0) return 0;
    const ids = inbound.map((m) => m.id);
    // A photo already on a quote, or on work (core/work-photos.ts), isn't taken again.
    const linked = await tx
      .select({ messageId: quoteAttachments.messageId, url: quoteAttachments.url })
      .from(quoteAttachments)
      .where(and(eq(quoteAttachments.orgId, orgId), inArray(quoteAttachments.messageId, ids)))
      .union(
        tx
          .select({ messageId: workPhotos.messageId, url: workPhotos.url })
          .from(workPhotos)
          .where(and(eq(workPhotos.orgId, orgId), inArray(workPhotos.messageId, ids))),
      );
    const seen = new Set(linked.map((l) => `${l.messageId}\n${l.url}`));
    const rows = inbound.flatMap((message) =>
      message.attachments
        .filter((a) => !a.document && !seen.has(`${message.id}\n${a.url}`))
        .map((a) => ({
          id: newId("att"),
          orgId,
          quoteId,
          messageId: message.id,
          url: a.url,
          name: a.name ?? null,
          mimeType: a.mimeType ?? null,
          // When it was sent, so photos keep the order the member sent them in ("the second photo").
          createdAt: message.createdAt,
        })),
    );
    if (rows.length) await tx.insert(quoteAttachments).values(rows);
    return rows.length;
  });
}

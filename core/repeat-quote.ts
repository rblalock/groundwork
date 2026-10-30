// A past quote proposed again at today's prices: its lines and rules checked against the price book and
// rules as they stand, priced by the same code a new quote is, and the create_quote input that makes it.
// Nothing is saved here; the member confirms first.
import { and, eq, inArray } from "drizzle-orm";
import { pricebookItems, quoteRevisions, quotes, rules } from "../schema/schema";
import type { Adjustment, LineResult } from "../schema/types";
import type { CalcResult } from "./calculator";
import { getCustomer } from "./customers";
import { db } from "./db";
import { localeFor, type Language } from "./language";
import type { Caller } from "./members";
import { formatCents } from "./money";
import { getProfileWith } from "./profile";
import { listQuotes, previewQuote, type CreateQuoteInput, type Quote, type ToolLine } from "./quotes";

/** same: today's price matches. repriced: it changed. retired: the item left the price book. unpriced: never in it. */
export type RepeatChange = "same" | "repriced" | "retired" | "unpriced";

export type RepeatLine = {
  itemId: string | null;
  name: string;
  unitLabel: string;
  quantity: number;
  thenUnitCents: number | null;
  nowUnitCents: number | null;
  change: RepeatChange;
};

export type RepeatRule = { ruleId: string; name: string; active: boolean };

/** agreed: their last approved, sent, or won quote. latest: none was, so their most recent one. */
export type RepeatBasis = "quote" | "agreed" | "latest";

type PriceBookItem = { id: string; name: string; unitLabel: string; priceCents: number; status: "active" | "retired" };
type RuleRow = { id: string; text: string; status: "active" | "retired" | "suggested" };

const AGREED: Quote["status"][] = ["approved", "sent", "won"];

/**
 * Last time's lines and rules against today's price book and rules, and the create_quote input for the
 * repeat. An item no longer in the price book goes on as a name-only line, so the quote waits for the
 * owner's price; a retired rule is left off. Last time's adjustments are never carried over.
 */
export function repeatProposal(args: {
  title: string;
  customerId: string | null;
  propertyId: string | null;
  lines: LineResult[];
  ruleIds: string[];
  /** Last time's rule labels, for a rule no longer on record. */
  ruleLabels: Map<string, string>;
  items: Map<string, PriceBookItem>;
  rules: Map<string, RuleRow>;
  privateNotes: string;
}): { lines: RepeatLine[]; rules: RepeatRule[]; createQuoteInput: CreateQuoteInput } {
  const lines: RepeatLine[] = [];
  const inputLines: ToolLine[] = [];
  for (const line of args.lines) {
    const item = line.itemId ? args.items.get(line.itemId) : undefined;
    if (item?.status === "active") {
      const nowUnitCents = item.priceCents;
      lines.push({
        itemId: item.id,
        name: line.name,
        unitLabel: item.unitLabel,
        quantity: line.quantity,
        thenUnitCents: line.unitCents,
        nowUnitCents,
        change: line.unitCents === nowUnitCents ? "same" : "repriced",
      });
      // The member's own words for the line stay; the price is today's.
      inputLines.push({ itemId: item.id, quantity: line.quantity, ...(line.name !== item.name ? { name: line.name } : {}) });
    } else {
      lines.push({
        itemId: line.itemId,
        name: line.name,
        unitLabel: line.unitLabel,
        quantity: line.quantity,
        thenUnitCents: line.unitCents,
        nowUnitCents: null,
        change: line.itemId ? "retired" : "unpriced",
      });
      inputLines.push({ name: line.name, unitLabel: line.unitLabel, quantity: line.quantity });
    }
  }
  const ruleList = [...new Set(args.ruleIds)].map((ruleId): RepeatRule => {
    const row = args.rules.get(ruleId);
    return { ruleId, name: row?.text ?? args.ruleLabels.get(ruleId) ?? ruleId, active: row?.status === "active" };
  });
  return {
    lines,
    rules: ruleList,
    createQuoteInput: {
      title: args.title,
      ...(args.customerId ? { customerId: args.customerId } : {}),
      ...(args.propertyId ? { propertyId: args.propertyId } : {}),
      lines: inputLines,
      ...(ruleList.some((r) => r.active) ? { ruleIds: ruleList.filter((r) => r.active).map((r) => r.ruleId) } : {}),
      privateNotes: args.privateNotes,
    },
  };
}

/** The total set by hand last time, and what was taken off, in cents; null when there was none. */
export function lastTimeAdjustments(adjustments: Adjustment[]): { lastTimeOverrideCents: number | null; lastTimeDiscountCents: number | null } {
  const override = adjustments.find((a) => a.kind === "override");
  const discounts = adjustments.filter((a) => a.kind === "discount");
  return {
    lastTimeOverrideCents: override ? override.amountCents : null,
    lastTimeDiscountCents: discounts.length ? discounts.reduce((sum, a) => sum + a.amountCents, 0) : null,
  };
}

type SummaryArgs = {
  title: string;
  date: string;
  customerName: string | null;
  /** Shown when the quote wasn't agreed: what became of it. */
  status: Quote["status"] | null;
  lines: RepeatLine[];
  rules: RepeatRule[];
  thenTotalCents: number;
  preview: Pick<CalcResult, "state" | "totalCents">;
  lastTimeOverrideCents: number | null;
  lastTimeDiscountCents: number | null;
};

const STATUS: Record<Language, Partial<Record<Quote["status"], string>>> = {
  en: { draft: "a draft", needs_owner: "waiting on the owner", lost: "lost", void: "void" },
  es: { draft: "borrador", needs_owner: "esperando al dueño", lost: "perdida", void: "anulada" },
};

const COPY = {
  en: {
    head: (title: string, when: string, who: string | null) => `Same as ${title} (${when})${who ? ` for ${who}` : ""}:`,
    totals: (then: string, today: string, changes: string) => `Then ${then}; today ${today}${changes ? ` (${changes})` : ""}.`,
    soFar: (total: string) => `${total} so far`,
    notPriced: "not priced yet",
    retired: (name: string) => `${name} isn't in the price book now; it stays unpriced for the owner.`,
    unpriced: (name: string) => `${name} has no saved price; it stays unpriced for the owner.`,
    ruleOff: (name: string) => `The rule "${name}" is retired, so it's left off.`,
    override: (total: string) => `Last time the total was set by hand to ${total}.`,
    discount: (amount: string) => `Last time ${amount} was taken off.`,
    ask: "Quote it?",
  },
  es: {
    head: (title: string, when: string, who: string | null) => `Igual que ${title} (${when})${who ? ` para ${who}` : ""}:`,
    totals: (then: string, today: string, changes: string) => `Antes ${then}; hoy ${today}${changes ? ` (${changes})` : ""}.`,
    soFar: (total: string) => `${total} hasta ahora`,
    notPriced: "sin precio todavía",
    retired: (name: string) => `${name} ya no está en la lista de precios; queda sin precio para el dueño.`,
    unpriced: (name: string) => `${name} no tiene precio guardado; queda sin precio para el dueño.`,
    ruleOff: (name: string) => `La regla "${name}" está retirada, así que no se aplica.`,
    override: (total: string) => `La última vez el total se fijó a mano en ${total}.`,
    discount: (amount: string) => `La última vez se descontaron ${amount}.`,
    ask: "¿La cotizo?",
  },
} satisfies Record<Language, unknown>;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const quantityText = (quantity: number) => String(Number(quantity.toFixed(2)));

/** The numbered confirm: last time's lines, then and today's totals, what changed, and what isn't repeated. */
export function repeatSummaryText(args: SummaryArgs, language: Language): string {
  const copy = COPY[language];
  const money = (cents: number) => formatCents(cents, language, { concise: true });
  const status = args.status ? STATUS[language][args.status] : undefined;
  const items = args.lines.map((line, index) => {
    const unit = oneLine(line.unitLabel);
    return `${index + 1}. ${oneLine(line.name)}, ${quantityText(line.quantity)}${unit ? ` ${unit}` : ""}`;
  });
  const changes = args.lines
    .filter((line) => line.change === "repriced" && line.thenUnitCents !== null && line.nowUnitCents !== null)
    .map((line) => {
      const unit = oneLine(line.unitLabel);
      return `${oneLine(line.name)} ${money(line.thenUnitCents!)} → ${money(line.nowUnitCents!)}${unit ? `/${unit}` : ""}`;
    })
    .join(", ");
  const today =
    args.preview.state === "ready"
      ? money(args.preview.totalCents)
      : args.preview.totalCents > 0
        ? copy.soFar(money(args.preview.totalCents))
        : copy.notPriced;
  return [
    copy.head(oneLine(args.title), status ? `${args.date}, ${status}` : args.date, args.customerName ? oneLine(args.customerName) : null),
    ...items,
    copy.totals(money(args.thenTotalCents), today, changes),
    ...args.lines.filter((line) => line.change === "retired").map((line) => copy.retired(oneLine(line.name))),
    ...args.lines.filter((line) => line.change === "unpriced").map((line) => copy.unpriced(oneLine(line.name))),
    ...args.rules.filter((rule) => !rule.active).map((rule) => copy.ruleOff(oneLine(rule.name))),
    ...(args.lastTimeOverrideCents !== null ? [copy.override(money(args.lastTimeOverrideCents))] : []),
    ...(args.lastTimeDiscountCents !== null ? [copy.discount(money(args.lastTimeDiscountCents))] : []),
    copy.ask,
  ].join("\n");
}

/** "Apr 12", with the year when it isn't this year's, in the business's time zone. */
export function repeatDate(at: Date, language: Language, timeZone: string, now: Date = new Date()): string {
  const year = (date: Date) => new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(date);
  return new Intl.DateTimeFormat(localeFor(language), {
    month: "short",
    day: "numeric",
    ...(year(at) === year(now) ? {} : { year: "numeric" }),
    timeZone,
  }).format(at);
}

/**
 * A repeat of `quoteId`, or of the customer's last agreed quote (else their latest). Creates nothing.
 * Throws `QUOTE_NOT_FOUND`, `CUSTOMER_NOT_FOUND`, `CUSTOMER_ARCHIVED`, or `NO_QUOTES`.
 */
export async function proposeRepeat(caller: Caller, target: { quoteId?: string; customerId?: string }) {
  const { orgId, language } = caller;
  let quoteId = target.quoteId ?? null;
  let basis: RepeatBasis = "quote";
  if (!quoteId) {
    if (!target.customerId) throw new Error("QUOTE_NOT_FOUND");
    const customer = await getCustomer(orgId, target.customerId);
    if (!customer) throw new Error("CUSTOMER_NOT_FOUND");
    const [agreed] = await listQuotes(orgId, { customerId: customer.id, status: AGREED, limit: 1 });
    const [latest] = agreed ? [agreed] : await listQuotes(orgId, { customerId: customer.id, limit: 1 });
    if (!latest) throw new Error("NO_QUOTES");
    quoteId = latest.quoteId;
    basis = agreed ? "agreed" : "latest";
  }

  const [row] = await db()
    .select({ quote: quotes, revision: quoteRevisions })
    .from(quotes)
    .innerJoin(quoteRevisions, and(eq(quoteRevisions.orgId, orgId), eq(quoteRevisions.id, quotes.currentRevisionId)))
    .where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId)));
  if (!row) throw new Error("QUOTE_NOT_FOUND");
  const { quote, revision } = row;

  const customer = quote.customerId ? await getCustomer(orgId, quote.customerId) : null;
  if (customer?.archivedAt) throw new Error(customer.mergedIntoId ? "CUSTOMER_MERGED" : "CUSTOMER_ARCHIVED");
  const property = customer?.properties.find((p) => p.id === quote.propertyId) ?? null;

  const itemIds = [...new Set(revision.lines.map((l) => l.itemId).filter((id): id is string => Boolean(id)))];
  const itemRows = itemIds.length
    ? await db().select().from(pricebookItems).where(and(eq(pricebookItems.orgId, orgId), inArray(pricebookItems.id, itemIds)))
    : [];
  const ruleRows = revision.ruleIds.length
    ? await db().select().from(rules).where(and(eq(rules.orgId, orgId), inArray(rules.id, revision.ruleIds)))
    : [];
  const profile = await getProfileWith(orgId, db());
  const date = repeatDate(revision.createdAt, language, profile.timeZone);

  const proposal = repeatProposal({
    title: quote.title,
    customerId: customer?.id ?? null,
    propertyId: property?.id ?? null,
    lines: revision.lines,
    ruleIds: revision.ruleIds,
    ruleLabels: new Map(revision.ruleLines.map((r) => [r.ruleId, r.label])),
    items: new Map(itemRows.map((item) => [item.id, item])),
    rules: new Map(ruleRows.map((rule) => [rule.id, rule])),
    privateNotes: language === "es" ? `Repetición de ${oneLine(quote.title)}, ${date}` : `Repeat of ${oneLine(quote.title)}, ${date}`,
  });
  const calc = await previewQuote(orgId, caller.memberId, proposal.createQuoteInput);
  const adjustments = lastTimeAdjustments(revision.adjustments);

  return {
    basis,
    source: {
      quoteId: quote.id,
      title: quote.title,
      createdAt: revision.createdAt.toISOString(),
      revisionNumber: revision.number,
      totalCents: revision.totalCents,
      status: quote.status,
      customerId: customer?.id ?? null,
      customerName: customer?.name ?? null,
      propertyId: property?.id ?? null,
      propertyAddress: property?.address ?? null,
    },
    lines: proposal.lines,
    rules: proposal.rules,
    ...adjustments,
    preview: {
      state: calc.state,
      reasons: calc.reasons,
      linesSubtotalCents: calc.linesSubtotalCents,
      ruleLines: calc.ruleLines,
      minimumAppliedCents: calc.minimumAppliedCents,
      taxCents: calc.taxCents,
      totalCents: calc.totalCents,
    },
    createQuoteInput: proposal.createQuoteInput,
    summaryText: repeatSummaryText(
      {
        title: quote.title,
        date,
        customerName: customer?.name ?? null,
        status: AGREED.includes(quote.status) ? null : quote.status,
        lines: proposal.lines,
        rules: proposal.rules,
        thenTotalCents: revision.totalCents,
        preview: calc,
        ...adjustments,
      },
      language,
    ),
  };
}

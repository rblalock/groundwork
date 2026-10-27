// A quote's customer link (/q/<token>): the customer opens the quote the owner signed off on, approves it
// with their name, and pays the deposit the business asks for, if any, by card. Approving there marks the
// quote won, as `set_quote_outcome` would, and texts the owners and admins. The token is the customer's
// only key, like an invoice's pay link: it's made the first time the link is asked for, and only for a
// quote that's approved, sent, or won (a draft isn't the customer's yet).
import { randomBytes } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { customers, quoteRevisions, quotes } from "../schema/schema";
import { appOrigin } from "./app-url";
import { db, type Db, type Tx } from "./db";
import { recordEvent } from "./events";
import { cancelFollowups } from "./followups";
import type { Language } from "./language";
import type { Member } from "./members";
import { formatCents } from "./money";
import { notifyOwners } from "./outbound";
import { getProfileWith } from "./profile";
import { takesCardPayments } from "./stripe-connection";
import { todayYmd } from "./time";

export type Quote = typeof quotes.$inferSelect;
type QuoteStatus = Quote["status"];

/** The statuses a quote's link opens for: the owner signed off on it. */
export const LINKABLE_STATUSES: QuoteStatus[] = ["approved", "sent", "won"];

/** Stripe's smallest card charge in dollars: a smaller deposit isn't asked. */
const MIN_DEPOSIT_CENTS = 50;

export function quoteLinkUrl(token: string): string {
  return `${appOrigin()}/q/${token}`;
}

/** The quote's customer link, making its token on first use. Null for a quote that isn't the customer's yet (or anymore). */
export async function customerLinkFor(orgId: string, quoteId: string, executor: Db | Tx = db()): Promise<string | null> {
  const fresh = randomBytes(18).toString("base64url");
  const [row] = await executor
    .update(quotes)
    .set({ customerToken: sql`coalesce(${quotes.customerToken}, ${fresh})` })
    .where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId), inArray(quotes.status, LINKABLE_STATUSES)))
    .returning({ token: quotes.customerToken });
  return row?.token ? quoteLinkUrl(row.token) : null;
}

/** The quote behind a customer link, in whichever business: the token is the customer's only key. */
export async function quoteByCustomerToken(token: string): Promise<Quote | null> {
  if (!/^[\w-]{16,64}$/.test(token)) return null;
  const [row] = await db().select().from(quotes).where(eq(quotes.customerToken, token));
  return row ?? null;
}

/** The deposit asked for a total at the business's share, or null when it asks none (or too little to charge). */
export function depositFor(totalCents: number, depositPercent: number): number | null {
  if (depositPercent <= 0 || totalCents <= 0) return null;
  const cents = Math.round((totalCents * Math.min(depositPercent, 100)) / 100);
  return cents >= MIN_DEPOSIT_CENTS ? cents : null;
}

/** Whether a quote that's open on its link is past its valid-until day, in the business's time zone. */
export function isExpired(validUntil: string, timeZone: string, now: Date): boolean {
  return todayYmd(timeZone, now) > validUntil;
}

export type LinkApproval =
  | { kind: "approved"; already: boolean }
  /** The quote changed since the customer opened it: they look again at the one that's there now. */
  | { kind: "changed" }
  | { kind: "unavailable"; reason: "not_found" | "not_ready" | "closed" | "expired" };

const NAME_MAX = 60;

/**
 * The name a customer signs with. Anyone with the link types it, and it reaches the owners' texts and the
 * assistant's context (always in quotes there), so it keeps only what names are made of: letters, spaces,
 * and . , ' - (no digits, links, or other punctuation), one line, 60 characters at most. Null when
 * nothing's left.
 */
export function signedName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value
    .normalize("NFC")
    .replace(/[^\p{L}\p{M}\s.,'\u2019-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return /\p{L}/u.test(name) && name.length <= NAME_MAX ? name : null;
}

/**
 * The customer approves the quote on its link, as `revisionId` (the revision the page showed them).
 * It must be the quote's current revision, approved or sent by the business, priced, and not past its
 * valid-until day. Marks it won with who signed, when, and which revision, and the deposit the business
 * asks for then; stops its follow-up nudges; and texts the owners and admins. Approving twice is a no-op.
 */
export async function approveFromLink(
  token: string,
  input: { name: string; revisionId: string },
  deps?: { now?: Date },
): Promise<LinkApproval> {
  const name = signedName(input.name);
  if (!name) throw new Error("NAME_REQUIRED");
  const now = deps?.now ?? new Date();
  const found = await quoteByCustomerToken(token);
  if (!found) return { kind: "unavailable", reason: "not_found" };
  const orgId = found.orgId;
  const outcome = await db().transaction(async (tx) => {
    const [quote] = await tx.select().from(quotes).where(and(eq(quotes.orgId, orgId), eq(quotes.id, found.id))).for("update");
    if (!quote) return { kind: "unavailable" as const, reason: "not_found" as const };
    if (quote.status === "won") return { kind: "approved" as const, already: true };
    if (quote.status === "draft" || quote.status === "needs_owner") return { kind: "unavailable" as const, reason: "not_ready" as const };
    if (quote.status !== "approved" && quote.status !== "sent") return { kind: "unavailable" as const, reason: "closed" as const };
    if (quote.currentRevisionId !== input.revisionId) return { kind: "changed" as const };
    const [revision] = await tx
      .select()
      .from(quoteRevisions)
      .where(and(eq(quoteRevisions.orgId, orgId), eq(quoteRevisions.id, input.revisionId)));
    if (!revision || revision.state !== "ready") return { kind: "unavailable" as const, reason: "not_ready" as const };
    const profile = await getProfileWith(orgId, tx);
    if (isExpired(revision.validUntil, profile.timeZone, now)) return { kind: "unavailable" as const, reason: "expired" as const };
    const depositCents = depositFor(revision.totalCents, profile.depositPercent);
    await tx
      .update(quotes)
      .set({
        status: "won",
        outcomeAt: now,
        customerApprovedAt: now,
        customerApprovedName: name,
        customerApprovedRevisionId: revision.id,
        depositCents,
        updatedAt: now,
      })
      .where(and(eq(quotes.orgId, orgId), eq(quotes.id, quote.id)));
    await cancelFollowups(orgId, quote.id, tx);
    await recordEvent(
      { orgId, kind: "quote.customer_approved", refId: quote.id, data: { revision: revision.number, totalCents: revision.totalCents, depositCents } },
      tx,
    );
    return { kind: "new" as const, notice: { title: quote.title, customerId: quote.customerId, totalCents: revision.totalCents, depositCents } };
  });
  if (outcome.kind !== "new") return outcome;
  const { notice } = outcome;
  const customerName = notice.customerId
    ? ((await db().select({ name: customers.name }).from(customers).where(and(eq(customers.orgId, orgId), eq(customers.id, notice.customerId))))[0]?.name ?? null)
    : null;
  const cards = notice.depositCents ? await takesCardPayments(orgId) : false;
  await notifyOwners(
    orgId,
    (member: Member) =>
      customerApprovedText(
        { title: notice.title, customerName, signedName: name, totalCents: notice.totalCents, depositCents: notice.depositCents, cards },
        member.language === "es" ? "es" : "en",
      ),
    "proactive",
    deps,
  ).catch((error) => console.error("quote-link: approval notice failed", error));
  return { kind: "approved", already: false };
}

// ---------------------------------------------------------------------------------------------
// The owners' texts

type Copy = {
  approved: (who: string, title: string, total: string) => string;
  signedBy: (name: string) => string;
  depositAsked: (amount: string) => string;
  depositNoCards: (amount: string) => string;
  bookIt: string;
  depositPaid: (who: string, amount: string, title: string) => string;
  depositOnInvoice: (label: string) => string;
  depositOver: (over: string) => string;
  depositClosed: (status: "lost" | "void") => string;
};

const COPY: Record<Language, Copy> = {
  en: {
    approved: (who, title, total) => `${who} approved the quote for ${title} (${total}) on its link.`,
    signedBy: (name) => `Signed "${name}".`,
    depositAsked: (amount) => `They were asked for a ${amount} deposit by card.`,
    depositNoCards: (amount) => `A ${amount} deposit is due, but Stripe isn't connected in Settings, so they can't pay it online.`,
    bookIt: "Want me to book the work?",
    depositPaid: (who, amount, title) => `${who} paid the ${amount} deposit by card on the quote for ${title}.`,
    depositOnInvoice: (label) => `It's on ${label}.`,
    depositOver: (over) => `That's ${over} more than was owed: refund the difference in Stripe.`,
    depositClosed: (status) => `The quote is marked ${status === "lost" ? "lost" : "void"}: refund it in Stripe.`,
  },
  es: {
    approved: (who, title, total) => `${who} aprobó la cotización de ${title} (${total}) en su enlace.`,
    signedBy: (name) => `Firmó "${name}".`,
    depositAsked: (amount) => `Se le pidió un depósito de ${amount} con tarjeta.`,
    depositNoCards: (amount) => `Hay un depósito de ${amount} pendiente, pero Stripe no está conectado en Ajustes, así que no puede pagarlo en línea.`,
    bookIt: "¿Agendo el trabajo?",
    depositPaid: (who, amount, title) => `${who} pagó el depósito de ${amount} con tarjeta en la cotización de ${title}.`,
    depositOnInvoice: (label) => `Está en ${label}.`,
    depositOver: (over) => `Son ${over} más de lo que debía: devuelve la diferencia en Stripe.`,
    depositClosed: (status) => `La cotización está marcada como ${status === "lost" ? "perdida" : "anulada"}: devuélvelo en Stripe.`,
  },
};

const money = (cents: number, language: Language) => formatCents(cents, language, { concise: true });
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** The text to owners and admins when a customer approves a quote on its link. */
export function customerApprovedText(
  input: { title: string; customerName: string | null; signedName: string; totalCents: number; depositCents: number | null; cards: boolean },
  language: Language,
): string {
  const copy = COPY[language];
  const who = input.customerName ? oneLine(input.customerName) : `"${input.signedName}"`;
  const parts = [copy.approved(who, oneLine(input.title), money(input.totalCents, language))];
  if (input.customerName && input.customerName.trim().toLowerCase() !== input.signedName.toLowerCase()) parts.push(copy.signedBy(input.signedName));
  if (input.depositCents) parts.push(input.cards ? copy.depositAsked(money(input.depositCents, language)) : copy.depositNoCards(money(input.depositCents, language)));
  parts.push(copy.bookIt);
  return parts.join(" ");
}

/** The text to owners and admins when a deposit comes in on a quote's link. */
export function depositPaidText(
  input: {
    title: string;
    customerName: string | null;
    signedName: string | null;
    amountCents: number;
    invoiceLabel: string | null;
    overpaidCents?: number;
    closedQuote?: "lost" | "void" | null;
  },
  language: Language,
): string {
  const copy = COPY[language];
  const who = input.customerName ? oneLine(input.customerName) : input.signedName ? `"${input.signedName}"` : oneLine(input.title);
  const parts = [copy.depositPaid(who, money(input.amountCents, language), oneLine(input.title))];
  if (input.invoiceLabel) parts.push(copy.depositOnInvoice(input.invoiceLabel));
  if (input.closedQuote) parts.push(copy.depositClosed(input.closedQuote));
  else if (input.overpaidCents && input.overpaidCents > 0) parts.push(copy.depositOver(money(input.overpaidCents, language)));
  return parts.join(" ");
}

// The customer's quote link (`app/q/`), as the page shows it: the business, the quote's priced lines and
// totals, and where it stands (open to approve, approved with its deposit, or not available). A draft and
// a closed quote show nothing of their lines: the token alone gets no more than the PDF would. A business
// that hides line prices from customers sends each line's scope and the totals, never a line's price.
import { and, eq } from "drizzle-orm";
import { quoteRevisions } from "../schema/schema";
import { logoVersionFor, pageBusiness, type PageBusiness } from "../core/branding";
import { getCustomer } from "../core/customers";
import { readStoredFile } from "../core/blob";
import { db } from "../core/db";
import { cardText, invoiceForQuote, quoteDeposits } from "../core/invoices";
import { isLanguage } from "../core/language";
import { pricedPhotosFor, quotePricedPhotos, renderTag, type PricedPhoto } from "../core/priced-photo";
import { getProfile } from "../core/profile";
import { depositFor, isExpired, quoteByCustomerToken } from "../core/quote-link";
import { takesCardPayments } from "../core/stripe-connection";
import { todayYmd } from "../core/time";
import type { ReceiptLine } from "./stripe";

export type QuoteLinkBusiness = PageBusiness;

export type QuoteLinkLine = { name: string; quantity: number; unitLabel: string | null; unitCents: number | null; totalCents: number | null };

export type QuoteLinkPage =
  | { kind: "not_found" }
  | { kind: "not_ready" | "closed"; orgId: string; business: QuoteLinkBusiness; title: string; language: "en" | "es" }
  | {
      /** `open`: the customer can approve it. `expired`: past its valid-until day. `approved`: it's won. */
      kind: "open" | "expired" | "approved";
      /** The business, for its own design of this page (lib/customer-pages.ts). Never shown. */
      orgId: string;
      business: QuoteLinkBusiness;
      language: "en" | "es";
      quote: {
        title: string;
        revisionId: string;
        customerName: string | null;
        address: string | null;
        /** False when the business hides line prices: every line's and rule's price is null, and only the totals show. */
        linePrices: boolean;
        lines: QuoteLinkLine[];
        ruleLines: { label: string; cents: number | null }[];
        subtotalCents: number;
        minimumAppliedCents: number;
        adjustmentCents: number;
        override: boolean;
        taxRateBp: number | null;
        taxCents: number;
        totalCents: number;
        validUntil: string;
        notes: string | null;
        pdfUrl: string | null;
        /**
         * The priced photos of this revision: the quote's own photos in attachment order (each legend
         * pointing to the others), or the newest when that's a finished-job photo. `version` changes when
         * one is made again or drawn again.
         */
        pricedPhotos: Array<{ id: string; version: string }>;
      };
      /** Who approved it on the link, and the day (`YYYY-MM-DD`, the business's). Null for a quote the business marked won itself. */
      approval: { name: string; at: string } | null;
      /**
       * The deposit: what an open quote will ask on approval (`dueCents` then is all of it), or what an
       * approved one asked and what's left (nothing once the quote is invoiced). Null when there's none.
       */
      deposit: { cents: number; paidCents: number; dueCents: number; payable: boolean } | null;
      /** The deposit payments made on the link, oldest first: the receipt. */
      payments: ReceiptLine[];
    };

/** What a customer opening the quote's link sees. */
export async function quoteLinkPage(token: string, deps?: { now?: Date }): Promise<QuoteLinkPage> {
  const now = deps?.now ?? new Date();
  const quote = await quoteByCustomerToken(token);
  if (!quote) return { kind: "not_found" };
  const [revision] = await db()
    .select()
    .from(quoteRevisions)
    .where(and(eq(quoteRevisions.orgId, quote.orgId), eq(quoteRevisions.id, quote.currentRevisionId ?? "")));
  if (!revision) return { kind: "not_found" };
  const profile = await getProfile(quote.orgId);
  const business = pageBusiness(profile, await logoVersionFor(quote.orgId));
  const language = isLanguage(revision.customerLanguage) ? revision.customerLanguage : "en";
  if (quote.status === "draft" || quote.status === "needs_owner" || revision.state !== "ready") {
    return { kind: "not_ready", orgId: quote.orgId, business, title: quote.title, language };
  }
  if (quote.status === "lost" || quote.status === "void") return { kind: "closed", orgId: quote.orgId, business, title: quote.title, language };

  const customer = quote.customerId ? await getCustomer(quote.orgId, quote.customerId) : null;
  const property = customer?.properties.find((p) => p.id === quote.propertyId) ?? null;
  const deposits = await quoteDeposits(quote.orgId, quote.id);
  const paidCents = deposits.reduce((sum, p) => sum + p.amountCents, 0);
  const approved = quote.status === "won";
  const asked = approved ? quote.depositCents : depositFor(revision.totalCents, profile.depositPercent);
  const payable = asked ? await takesCardPayments(quote.orgId) : false;
  // Once it's invoiced, the invoice's pay link takes the money: the deposit isn't asked here anymore.
  const invoiced = approved && asked ? Boolean(await invoiceForQuote(quote.orgId, quote.id)) : false;
  // Only those drawn from this revision: an older one's labels would show old prices. With line prices
  // hidden, only those that have their quantity-only copy (older photos may have none).
  const shown = (p: PricedPhoto) => p.revisionNumber === revision.number && (profile.customerLinePrices || p.customerUrl !== null);
  const newest = (await pricedPhotosFor(quote.orgId, quote.id)).find(shown);
  const priced = !newest ? [] : newest.sourceKind === "quote_attachment" ? (await quotePricedPhotos(quote.orgId, quote.id)).filter(shown) : [newest];
  return {
    kind: approved ? "approved" : isExpired(revision.validUntil, profile.timeZone, now) ? "expired" : "open",
    orgId: quote.orgId,
    business,
    language,
    quote: {
      title: quote.title,
      revisionId: revision.id,
      customerName: customer?.name ?? null,
      address: property?.address ?? null,
      linePrices: profile.customerLinePrices,
      lines: revision.lines.map((l) => ({
        name: l.name,
        quantity: l.quantity,
        unitLabel: l.unitLabel || null,
        unitCents: profile.customerLinePrices ? l.unitCents : null,
        totalCents: profile.customerLinePrices ? l.totalCents : null,
      })),
      ruleLines: revision.ruleLines.map((r) => ({ label: r.label, cents: profile.customerLinePrices ? r.cents : null })),
      subtotalCents: revision.subtotalCents,
      minimumAppliedCents: revision.minimumAppliedCents,
      adjustmentCents: revision.adjustmentCents,
      override: revision.adjustments.some((a) => a.kind === "override"),
      taxRateBp: revision.taxRateBp,
      taxCents: revision.taxCents,
      totalCents: revision.totalCents,
      validUntil: revision.validUntil,
      notes: revision.customerNotes?.trim() || null,
      pdfUrl: revision.pdfUrl,
      pricedPhotos: priced.map((p) => ({ id: p.id, version: `${p.createdAt.getTime()}.${renderTag((profile.customerLinePrices ? p.url : p.customerUrl) ?? "")}` })),
    },
    approval: quote.customerApprovedAt && quote.customerApprovedName ? { name: quote.customerApprovedName, at: todayYmd(profile.timeZone, quote.customerApprovedAt) } : null,
    deposit: asked ? { cents: asked, paidCents, dueCents: invoiced ? 0 : Math.max(0, asked - (approved ? paidCents : 0)), payable } : null,
    payments: deposits.map((p) => ({ id: p.id, receivedDate: p.receivedDate, method: p.method, card: cardText(p), amountCents: p.amountCents })),
  };
}

/**
 * The priced photo the quote's link shows, as its stored bytes (a JPEG, or a PNG drawn before copies
 * were JPEGs): only the one its page shows (this quote's, of its current revision, while the page shows
 * the quote at all), and its quantity-only copy when the business hides line prices. Null for anything
 * else, another quote's included.
 */
export async function quoteLinkPricedPhoto(token: string, pricedId: string): Promise<Uint8Array | null> {
  const [quote, page] = await Promise.all([quoteByCustomerToken(token), quoteLinkPage(token)]);
  if (!quote || !("quote" in page) || !page.quote.pricedPhotos.some((p) => p.id === pricedId)) return null;
  const photo = (await pricedPhotosFor(quote.orgId, quote.id)).find((p) => p.id === pricedId);
  const url = page.quote.linePrices ? photo?.url : photo?.customerUrl;
  return url ? readStoredFile(url) : null;
}

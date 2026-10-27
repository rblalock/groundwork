// The customer's quote link (`app/q/`), as the page shows it: the business, the quote's priced lines and
// totals, and where it stands (open to approve, approved with its deposit, or not available). A draft and
// a closed quote show nothing of their lines: the token alone gets no more than the PDF would.
import { and, eq } from "drizzle-orm";
import { quoteRevisions } from "../schema/schema";
import { logoVersionFor, pageBusiness, type PageBusiness } from "../core/branding";
import { getCustomer } from "../core/customers";
import { db } from "../core/db";
import { cardText, invoiceForQuote, quoteDeposits } from "../core/invoices";
import { isLanguage } from "../core/language";
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
        lines: QuoteLinkLine[];
        ruleLines: { label: string; cents: number }[];
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
      lines: revision.lines.map((l) => ({ name: l.name, quantity: l.quantity, unitLabel: l.unitLabel || null, unitCents: l.unitCents, totalCents: l.totalCents })),
      ruleLines: revision.ruleLines.map((r) => ({ label: r.label, cents: r.cents })),
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
    },
    approval: quote.customerApprovedAt && quote.customerApprovedName ? { name: quote.customerApprovedName, at: todayYmd(profile.timeZone, quote.customerApprovedAt) } : null,
    deposit: asked ? { cents: asked, paidCents, dueCents: invoiced ? 0 : Math.max(0, asked - (approved ? paidCents : 0)), payable } : null,
    payments: deposits.map((p) => ({ id: p.id, receivedDate: p.receivedDate, method: p.method, card: cardText(p), amountCents: p.amountCents })),
  };
}


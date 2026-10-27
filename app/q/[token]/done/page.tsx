import Link from "next/link";
import { CircleCheck, Clock } from "lucide-react";
import { DepositReceipt, QuoteLinkHeader } from "@/components/quotes/quote-link";
import { pageCopyFor } from "@/lib/page-copy";
import { quoteLinkPage } from "@/lib/quote-page";
import { confirmDepositCheckout, type CheckoutConfirmation } from "@/lib/stripe";
import { DocumentLanguage } from "@/components/document-language";

export const dynamic = "force-dynamic";

/**
 * Where Stripe sends the customer after paying a quote's deposit, with the Checkout Session's id. Like the
 * pay link's done page, it asks Stripe about that session (`confirmDepositCheckout`, which trusts nothing
 * in the URL), so a paid deposit is recorded then and there and the customer leaves with a receipt.
 */
export default async function QuoteDepositDonePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ session_id?: string | string[] }>;
}) {
  const { token } = await params;
  const { session_id: sessionId } = await searchParams;
  let confirmation: CheckoutConfirmation = "none";
  if (typeof sessionId === "string" && sessionId) {
    confirmation = await confirmDepositCheckout(token, sessionId).catch((error: unknown) => {
      console.error("quote link: confirming the deposit failed", error);
      return "none" as const;
    });
  }
  const page = await quoteLinkPage(token);
  if (page.kind === "not_found") return <p className="text-center text-[14px] text-ink-2">{pageCopyFor("en").quoteLink.notFound}</p>;
  const { business, language } = page;
  const q = pageCopyFor(language).quoteLink;
  const full = "quote" in page ? page : null;
  const received = confirmation === "paid" || Boolean(full && full.payments.length > 0);
  const processing = confirmation === "processing" && !received;
  return (
    <div className="space-y-5">
      <DocumentLanguage lang={language} />
      <QuoteLinkHeader page={page} token={token} />
      <div className="space-y-1.5 rounded-card bg-surface px-4 py-3 shadow-card">
        <p className="flex items-center gap-2 text-[15px] font-semibold text-ink">
          {processing ? (
            <Clock aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
          ) : (
            <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-green" />
          )}
          {processing ? q.processingTitle : q.doneTitle}
        </p>
        <p className="text-[13px] text-ink-2 text-pretty">
          {processing ? q.processing(business.name) : received ? q.received(business.name) : q.done(business.name)}
        </p>
      </div>
      {full ? <DepositReceipt page={full} /> : null}
      <Link className="block text-center text-[13px] font-medium text-ink-2 hover:text-ink" href={`/q/${token}`}>
        {q.back}
      </Link>
    </div>
  );
}

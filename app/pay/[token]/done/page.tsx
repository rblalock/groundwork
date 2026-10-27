import { CircleCheck, Clock } from "lucide-react";
import { PayHeader, PayReceipt } from "@/components/invoices/pay-receipt";
import { pageCopyFor } from "@/lib/page-copy";
import { confirmCheckout, payPage, type CheckoutConfirmation } from "@/lib/stripe";
import { DocumentLanguage } from "@/components/document-language";

export const dynamic = "force-dynamic";

/**
 * Where Stripe sends the customer after paying, with the Checkout Session's id. It asks Stripe about that
 * session rather than wait for the webhook (`confirmCheckout`, which trusts nothing in the URL): a paid
 * one is recorded then and there, so the customer leaves with a receipt. A payment still clearing shows
 * as processing; with no session to confirm, the page thanks them and the webhook records it.
 */
export default async function PayDonePage({
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
    confirmation = await confirmCheckout(token, sessionId).catch((error: unknown) => {
      console.error("pay: confirming checkout failed", error);
      return "none" as const;
    });
  }
  const page = await payPage(token);
  if (page.kind === "not_found") return <p className="text-center text-[14px] text-ink-2">{pageCopyFor("en").pay.notFound}</p>;
  const { business } = page;
  const p = pageCopyFor(page.invoice.language).pay;
  const contact = [business.phone, business.email].filter(Boolean).join(" · ");
  const processing = confirmation === "processing" && page.kind !== "paid";
  const received = confirmation === "paid" || page.kind === "paid";
  return (
    <div className="space-y-5">
      <DocumentLanguage lang={page.invoice.language} />
      <PayHeader page={page} token={token} />
      <div className="space-y-1.5 rounded-card bg-surface px-4 py-3 shadow-card">
        <p className="flex items-center gap-2 text-[15px] font-semibold text-ink">
          {processing ? (
            <Clock aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
          ) : (
            <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-green" />
          )}
          {processing ? p.processingTitle : p.doneTitle}
        </p>
        <p className="text-[13px] text-ink-2 text-pretty">
          {processing ? p.processing(business.name) : received ? p.received(business.name) : p.done(business.name)}
        </p>
        {!processing && !received ? <p className="text-[12px] text-ink-3 text-pretty">{p.doneNote}</p> : null}
      </div>
      <PayReceipt page={page} token={token} />
      {contact ? (
        <p className="text-center text-[12px] text-ink-3">
          {p.contact} {contact}
        </p>
      ) : null}
    </div>
  );
}

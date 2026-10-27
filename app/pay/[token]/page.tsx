import { CircleCheck, CircleX, CreditCard } from "lucide-react";
import { PayHeader, PayReceipt } from "@/components/invoices/pay-receipt";
import { formatDateOnlyShort, money } from "@/lib/format";
import { pageCopyFor } from "@/lib/page-copy";
import { payPage } from "@/lib/stripe";
import { DocumentLanguage } from "@/components/document-language";
import { redirect } from "next/navigation";
import { publishedTemplate } from "@/core/customer-pages";

export const dynamic = "force-dynamic";

/**
 * An invoice's pay link, as the customer sees it: what's due and a button to pay it by card, and the
 * receipt for whatever's been paid so far. Opening this page charges nothing (a link preview may load
 * it); the button opens Stripe's checkout.
 */
export default async function PayPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ standard?: string }> }) {
  const { token } = await params;
  const { standard } = await searchParams;
  const page = await payPage(token);
  if (page.kind === "not_found") {
    return <p className="text-center text-[14px] text-ink-2">{pageCopyFor("en").pay.notFound}</p>;
  }
  // The business's own design, when it has published one (`standard` is its way back here when it can't show).
  if (!standard && (await publishedTemplate(page.orgId, "invoice"))) redirect(`/pay/${encodeURIComponent(token)}/view`);
  const { business, invoice } = page;
  const language = invoice.language;
  const p = pageCopyFor(language).pay;
  const contact = [business.phone, business.email].filter(Boolean).join(" · ");
  return (
    <div className="space-y-5">
      <DocumentLanguage lang={language} />
      <PayHeader page={page} token={token} />

      {page.kind === "payable" ? (
        <>
          <div className="rounded-card bg-surface px-4 py-3 shadow-card">
            <p className="text-[12px] text-ink-3">{p.balanceDue}</p>
            <p className="text-2xl font-semibold text-ink tabular-nums">{money(invoice.balanceCents, language)}</p>
            <p className="text-[12px] text-ink-3">
              {invoice.dueDate && invoice.dueDate !== invoice.issueDate ? p.due(formatDateOnlyShort(invoice.dueDate, language)) : p.dueOnReceipt}
            </p>
          </div>
          <form action={`/pay/${token}/checkout`} method="post">
            <button
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-ink px-4 py-[11px] text-sm font-medium text-canvas transition-opacity hover:opacity-90"
              type="submit"
            >
              <CreditCard aria-hidden="true" className="size-4" />
              {p.pay(money(invoice.balanceCents, language))}
            </button>
          </form>
          <p className="text-center text-[12px] text-ink-3 text-pretty">{p.secure(business.name)}</p>
        </>
      ) : (
        <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-[13px] text-ink shadow-card text-pretty">
          {page.kind === "paid" ? (
            <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-green" />
          ) : (
            <CircleX aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-3" />
          )}
          {page.kind === "paid" ? p.paid : page.kind === "void" ? p.void(business.name) : p.unavailable(business.name)}
        </p>
      )}
      <PayReceipt page={page} token={token} />
      {contact ? (
        <p className="text-center text-[12px] text-ink-3">
          {p.contact} {contact}
        </p>
      ) : null}
    </div>
  );
}

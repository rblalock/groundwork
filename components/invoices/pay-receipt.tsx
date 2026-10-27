import { CircleCheck, Download } from "lucide-react";
import { formatDateOnlyShort, money } from "@/lib/format";
import { pageCopyFor } from "@/lib/page-copy";
import type { PayPage } from "@/lib/stripe";

// The customer's pay link pages (`app/pay/`): the business and invoice at the top, and the receipt once
// anything has been paid. No sign-in: the pay token in the URL is the customer's key.

type Shown = Exclude<PayPage, { kind: "not_found" }>;

/** The business (its logo when it has one) and the invoice, at the top of the pay link's pages. */
export function PayHeader({ page, token }: { page: Shown; token: string }) {
  const { business, invoice } = page;
  const p = pageCopyFor(invoice.language).pay;
  return (
    <header className="space-y-1">
      {business.logoVersion ? (
        // eslint-disable-next-line @next/next/no-img-element -- served by this link's own route, no sign-in
        <img
          alt={business.name}
          className="mb-3 max-h-12 w-auto max-w-[180px] object-contain object-left"
          src={`/pay/${token}/logo?v=${business.logoVersion}`}
        />
      ) : null}
      <p className="text-[13px] font-medium text-ink-2">{p.from(business.name)}</p>
      <h1 className="text-lg font-semibold text-ink tabular-nums">{p.title(invoice.label)}</h1>
      <p className="text-[13px] text-ink-2 text-pretty">{invoice.title}</p>
    </header>
  );
}

/**
 * The receipt: each payment still on the invoice (its day, how it was paid, how much), then the total,
 * what's been paid, and what's left or "Paid in full", with the PDF to keep. Nothing until something's paid.
 */
export function PayReceipt({ page, token }: { page: Shown; token: string }) {
  if (page.payments.length === 0) return null;
  const { invoice } = page;
  const language = invoice.language;
  const p = pageCopyFor(language).pay;
  return (
    <section aria-labelledby="receipt-title" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-ink" id="receipt-title">
          {p.receipt}
        </h2>
        <span className="text-[12px] text-ink-3 tabular-nums">{invoice.label}</span>
      </div>
      <ul className="divide-y divide-line rounded-card bg-surface shadow-card">
        {page.payments.map((payment) => (
          <li className="flex items-center gap-3 px-4 py-2.5 text-[13px]" key={payment.id}>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-ink">{payment.card ?? p.methods[payment.method]}</p>
              <p className="text-[12px] text-ink-3">{formatDateOnlyShort(payment.receivedDate, language)}</p>
            </div>
            <span className="text-ink tabular-nums">{money(payment.amountCents, language)}</span>
          </li>
        ))}
      </ul>
      <dl className="space-y-1 px-1 text-[13px]">
        <div className="flex justify-between gap-3">
          <dt className="text-ink-2">{p.invoiceTotal}</dt>
          <dd className="text-ink tabular-nums">{money(invoice.totalCents, language)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-ink-2">{p.paidSoFar}</dt>
          <dd className="text-ink tabular-nums">{money(invoice.paidCents, language)}</dd>
        </div>
        <div className="flex justify-between gap-3 border-t border-line pt-1.5 font-semibold text-ink">
          {invoice.balanceCents > 0 ? (
            <>
              <dt>{p.balanceLeft}</dt>
              <dd className="tabular-nums">{money(invoice.balanceCents, language)}</dd>
            </>
          ) : (
            <dt className="flex items-center gap-1.5">
              <CircleCheck aria-hidden="true" className="size-4 text-green" />
              {p.paidInFull}
            </dt>
          )}
        </div>
      </dl>
      <a
        className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-line px-4 py-[9px] text-[13px] font-medium text-ink transition-colors hover:bg-surface"
        download
        href={`/pay/${token}/receipt`}
      >
        <Download aria-hidden="true" className="size-4" />
        {p.download}
      </a>
    </section>
  );
}

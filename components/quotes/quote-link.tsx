import { CircleCheck, Download } from "lucide-react";
import { pluralUnit } from "@/core/units";
import { formatDateOnlyShort, money, quantity } from "@/lib/format";
import { pageCopyFor } from "@/lib/page-copy";
import type { QuoteLinkPage } from "@/lib/quote-page";

// The customer's quote link pages (`app/q/`): the business and quote at the top, the priced lines and
// totals, and the deposit's receipt once one's been paid. No sign-in: the token in the URL is the key.

type Shown = Exclude<QuoteLinkPage, { kind: "not_found" }>;
type Full = Extract<QuoteLinkPage, { quote: unknown }>;

const rateText = (bp: number, language: "en" | "es") => (bp / 100).toLocaleString(language === "es" ? "es-US" : "en-US", { maximumFractionDigits: 3 });

/** The business (its logo when it has one) and the quote's title, at the top of the link's pages. */
export function QuoteLinkHeader({ page, token }: { page: Shown; token: string }) {
  const { business, language } = page;
  const q = pageCopyFor(language).quoteLink;
  const title = "quote" in page ? page.quote.title : page.title;
  return (
    <header className="space-y-1">
      {business.logoVersion ? (
        // eslint-disable-next-line @next/next/no-img-element -- served by this link's own route, no sign-in
        <img
          alt={business.name}
          className="mb-3 max-h-12 w-auto max-w-[180px] object-contain object-left"
          src={`/q/${token}/logo?v=${business.logoVersion}`}
        />
      ) : null}
      <p className="text-[13px] font-medium text-ink-2">{q.from(business.name)}</p>
      <h1 className="text-lg font-semibold text-ink">{q.title}</h1>
      <p className="text-[13px] text-ink-2 text-pretty">{title}</p>
    </header>
  );
}

/** Who it's for, the priced photo when there is one, each priced line, the totals, how long it's good for, and the PDF. */
export function QuoteLinkDetails({ page, token }: { page: Full; token: string }) {
  const { quote, language } = page;
  const q = pageCopyFor(language).quoteLink;
  const rows: Array<{ label: string; cents: number }> = [{ label: q.subtotal, cents: quote.subtotalCents }];
  if (quote.minimumAppliedCents !== 0) rows.push({ label: q.minimum, cents: quote.minimumAppliedCents });
  if (quote.adjustmentCents !== 0) rows.push({ label: quote.override ? q.override : q.discount, cents: quote.adjustmentCents });
  if (quote.taxRateBp !== null) rows.push({ label: q.tax(rateText(quote.taxRateBp, language)), cents: quote.taxCents });
  return (
    <section className="space-y-3">
      {quote.customerName || quote.address ? (
        <div className="text-[13px]">
          <p className="text-[12px] text-ink-3">{q.preparedFor}</p>
          {quote.customerName ? <p className="font-medium text-ink">{quote.customerName}</p> : null}
          {quote.address ? <p className="text-ink-2">{quote.address}</p> : null}
        </div>
      ) : null}
      {quote.pricedPhoto ? (
        <figure className="space-y-1.5">
          {/* eslint-disable-next-line @next/next/no-img-element -- served by this link's own route, no sign-in */}
          <img
            alt={q.pricedAlt}
            className="block h-auto w-full rounded-card shadow-card"
            src={`/q/${token}/priced/${quote.pricedPhoto.id}?v=${quote.pricedPhoto.version}`}
          />
          <figcaption className="px-1 text-[12px] text-ink-3">{q.pricedCaption}</figcaption>
        </figure>
      ) : null}
      <ul className="divide-y divide-line rounded-card bg-surface shadow-card">
        {quote.lines.map((line, i) => (
          <li className="flex items-start gap-3 px-4 py-2.5 text-[13px]" key={i}>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-ink text-pretty">{line.name}</p>
              <p className="text-[12px] text-ink-3 tabular-nums">
                {quantity(line.quantity)}
                {line.unitLabel ? ` ${pluralUnit(line.quantity, line.unitLabel, language)}` : ""}
                {line.unitCents !== null ? ` × ${money(line.unitCents, language)}` : ""}
              </p>
            </div>
            <span className="text-ink tabular-nums">{line.totalCents === null ? "—" : money(line.totalCents, language)}</span>
          </li>
        ))}
        {quote.ruleLines.map((rule, i) => (
          <li className="flex items-start gap-3 px-4 py-2.5 text-[13px]" key={`r${i}`}>
            <p className="min-w-0 flex-1 text-ink-2 text-pretty">{rule.label}</p>
            <span className="text-ink-2 tabular-nums">{money(rule.cents, language)}</span>
          </li>
        ))}
      </ul>
      <dl className="space-y-1 px-1 text-[13px]">
        {rows.map((row) => (
          <div className="flex justify-between gap-3" key={row.label}>
            <dt className="text-ink-2">{row.label}</dt>
            <dd className="text-ink tabular-nums">{money(row.cents, language)}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-3 border-t border-line pt-1.5 text-[15px] font-semibold text-ink">
          <dt>{q.total}</dt>
          <dd className="tabular-nums">{money(quote.totalCents, language)}</dd>
        </div>
      </dl>
      {page.kind !== "approved" ? <p className="px-1 text-[12px] text-ink-3">{q.validUntil(formatDateOnlyShort(quote.validUntil, language))}</p> : null}
      {quote.notes ? (
        <div className="px-1 text-[13px]">
          <p className="text-[12px] text-ink-3">{q.notes}</p>
          <p className="whitespace-pre-line text-ink text-pretty">{quote.notes}</p>
        </div>
      ) : null}
      {quote.pdfUrl ? (
        <a
          className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-line px-4 py-[9px] text-[13px] font-medium text-ink transition-colors hover:bg-surface"
          href={quote.pdfUrl}
          rel="noreferrer"
          target="_blank"
        >
          <Download aria-hidden="true" className="size-4" />
          {q.pdf}
        </a>
      ) : null}
    </section>
  );
}

/** The deposit's receipt: each payment made on the link, and the deposit's total. Nothing until something's paid. */
export function DepositReceipt({ page }: { page: Full }) {
  if (page.payments.length === 0) return null;
  const { language } = page;
  const q = pageCopyFor(language).quoteLink;
  const methods = pageCopyFor(language).pay.methods;
  const paid = page.payments.reduce((sum, p) => sum + p.amountCents, 0);
  return (
    <section aria-labelledby="receipt-title" className="space-y-3">
      <h2 className="text-[13px] font-semibold text-ink" id="receipt-title">
        {q.receipt}
      </h2>
      <ul className="divide-y divide-line rounded-card bg-surface shadow-card">
        {page.payments.map((payment) => (
          <li className="flex items-center gap-3 px-4 py-2.5 text-[13px]" key={payment.id}>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-ink">{payment.card ?? methods[payment.method]}</p>
              <p className="text-[12px] text-ink-3">{formatDateOnlyShort(payment.receivedDate, language)}</p>
            </div>
            <span className="text-ink tabular-nums">{money(payment.amountCents, language)}</span>
          </li>
        ))}
      </ul>
      <dl className="space-y-1 px-1 text-[13px]">
        <div className="flex justify-between gap-3 font-semibold text-ink">
          <dt className="flex items-center gap-1.5">
            <CircleCheck aria-hidden="true" className="size-4 text-green" />
            {q.depositTotal}
          </dt>
          <dd className="tabular-nums">{money(paid, language)}</dd>
        </div>
      </dl>
      <p className="px-1 text-[12px] text-ink-3">{q.depositRest}</p>
    </section>
  );
}

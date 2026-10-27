import { CircleAlert, CircleCheck, CircleX, CreditCard } from "lucide-react";
import { DepositReceipt, QuoteLinkDetails, QuoteLinkHeader } from "@/components/quotes/quote-link";
import { formatDateOnlyShort, money } from "@/lib/format";
import { pageCopyFor } from "@/lib/page-copy";
import { quoteLinkPage } from "@/lib/quote-page";
import { DocumentLanguage } from "@/components/document-language";
import { redirect } from "next/navigation";
import { publishedTemplate } from "@/core/customer-pages";

export const dynamic = "force-dynamic";

/**
 * A quote's customer link, as the customer sees it: the quote, then a form to approve it with their name
 * and, once it's approved, the deposit to pay by card if the business asks one. Opening this page changes
 * nothing (a link preview may load it); approving and paying are form posts.
 */
export default async function QuoteLinkRoute({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ changed?: string; name?: string; standard?: string }>;
}) {
  const { token } = await params;
  const { changed, name, standard } = await searchParams;
  const page = await quoteLinkPage(token);
  if (page.kind === "not_found") return <p className="text-center text-[14px] text-ink-2">{pageCopyFor("en").quoteLink.notFound}</p>;
  // The business's own design, when it has published one (`standard` is its way back here when it can't show).
  if ("quote" in page && !standard && (await publishedTemplate(page.orgId, "quote"))) {
    const query = new URLSearchParams({ ...(changed ? { changed } : {}), ...(name ? { name } : {}) }).toString();
    redirect(`/q/${encodeURIComponent(token)}/view${query ? `?${query}` : ""}`);
  }
  const { business, language } = page;
  const q = pageCopyFor(language).quoteLink;
  const contact = [business.phone, business.email].filter(Boolean).join(" · ");
  const footer = contact ? (
    <p className="text-center text-[12px] text-ink-3">
      {pageCopyFor(language).pay.contact} {contact}
    </p>
  ) : null;

  if (!("quote" in page)) {
    return (
      <div className="space-y-5">
        <DocumentLanguage lang={language} />
        <QuoteLinkHeader page={page} token={token} />
        <Notice icon="x">{page.kind === "not_ready" ? q.notReady(business.name) : q.closed(business.name)}</Notice>
        {footer}
      </div>
    );
  }

  const { deposit } = page;
  return (
    <div className="space-y-5">
      <DocumentLanguage lang={language} />
      <QuoteLinkHeader page={page} token={token} />
      {page.kind === "approved" ? (
        <div className="space-y-1.5 rounded-card bg-surface px-4 py-3 shadow-card">
          <p className="flex items-center gap-2 text-[15px] font-semibold text-ink">
            <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-green" />
            {q.approvedTitle}
          </p>
          <p className="text-[13px] text-ink-2 text-pretty">
            {page.approval ? q.approvedBy(page.approval.name, formatDateOnlyShort(page.approval.at, language)) : q.approvedPlain} {q.thanks(business.name)}
          </p>
        </div>
      ) : null}

      {page.kind === "approved" && deposit && deposit.dueCents > 0 ? (
        <section className="space-y-3">
          <div className="rounded-card bg-surface px-4 py-3 shadow-card">
            <p className="text-[12px] text-ink-3">{q.depositTitle}</p>
            <p className="text-2xl font-semibold text-ink tabular-nums">{money(deposit.dueCents, language)}</p>
          </div>
          {deposit.payable ? (
            <>
              <form action={`/q/${token}/deposit`} method="post">
                <button
                  className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-ink px-4 py-[11px] text-sm font-medium text-canvas transition-opacity hover:opacity-90"
                  type="submit"
                >
                  <CreditCard aria-hidden="true" className="size-4" />
                  {q.payDeposit(money(deposit.dueCents, language))}
                </button>
              </form>
              <p className="text-center text-[12px] text-ink-3 text-pretty">{pageCopyFor(language).pay.secure(business.name)}</p>
            </>
          ) : (
            <Notice icon="x">{q.depositUnavailable(business.name)}</Notice>
          )}
        </section>
      ) : null}
      {page.kind === "approved" && deposit && deposit.dueCents === 0 && deposit.paidCents > 0 ? <Notice icon="check">{q.depositPaid}</Notice> : null}
      <DepositReceipt page={page} />

      <QuoteLinkDetails page={page} token={token} />

      {page.kind === "expired" ? <Notice icon="x">{q.expired(business.name)}</Notice> : null}
      {page.kind === "open" ? (
        <form action={`/q/${token}/approve`} className="space-y-3 rounded-card bg-surface px-4 py-4 shadow-card" method="post">
          <h2 className="text-[15px] font-semibold text-ink">{q.approveTitle}</h2>
          {changed ? <Notice icon="alert">{q.changed}</Notice> : null}
          <p className="text-[13px] text-ink-2 text-pretty">{q.approveHelp(business.name)}</p>
          {deposit ? <p className="text-[13px] font-medium text-ink text-pretty">{q.depositAhead(money(deposit.cents, language))}</p> : null}
          <input name="revisionId" type="hidden" value={page.quote.revisionId} />
          <label className="block space-y-1 text-[13px]">
            <span className="text-ink-2">{q.name}</span>
            <input
              aria-invalid={name ? true : undefined}
              autoComplete="name"
              className="w-full rounded-lg border border-line bg-page px-3 py-2 text-[14px] text-ink outline-none focus:border-ink-3"
              maxLength={60}
              name="name"
              required
              type="text"
            />
          </label>
          {name ? (
            <p className="text-[12px] text-destructive" role="alert">
              {q.nameRequired}
            </p>
          ) : null}
          <button
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-ink px-4 py-[11px] text-sm font-medium text-canvas transition-opacity hover:opacity-90"
            type="submit"
          >
            <CircleCheck aria-hidden="true" className="size-4" />
            {q.approve}
          </button>
        </form>
      ) : null}
      {footer}
    </div>
  );
}

function Notice({ icon, children }: { icon: "check" | "x" | "alert"; children: React.ReactNode }) {
  const Icon = icon === "check" ? CircleCheck : icon === "alert" ? CircleAlert : CircleX;
  return (
    <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-[13px] text-ink shadow-card text-pretty">
      <Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${icon === "check" ? "text-green" : "text-ink-3"}`} />
      {children}
    </p>
  );
}

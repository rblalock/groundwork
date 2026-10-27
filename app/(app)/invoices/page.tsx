import Link from "next/link";
import { ReceiptText } from "lucide-react";
import { CreateInvoiceButton, NewInvoiceButton } from "@/components/invoices/actions";
import { AskAssistantButton } from "@/components/threads/thread-rail";
import { copyFor } from "@/lib/copy";
import { InvoiceStatusPill, MoneyTabs, Stat } from "@/components/invoices/kit";
import { Card, LinkRow, Nothing, PageBody, Table, Td, Th, ViewingNotice } from "@/components/pages/kit";
import { SearchBox } from "@/components/pages/client-kit";
import { EmptyState, PaperPage } from "@/components/paper";
import { formatDateOnlyShort, money } from "@/lib/format";
import { pageCopyFor } from "@/lib/page-copy";
import { pagePrivileged } from "@/lib/page-session";
import { INVOICE_FILTERS, invoicesFor, isInvoiceFilter, parseInvoiceCursor } from "@/lib/pages/invoices";
import type { InvoiceFilter } from "@/core/invoices";
import { cn } from "@/ui/lib/utils";

type Search = Promise<{ status?: string; q?: string; before?: string; after?: string }>;

const pagerClass = "flex h-7 items-center rounded-full bg-surface px-3 text-ink shadow-hairline transition-colors hover:bg-hover";

/**
 * The business's invoices, for owners and admins: what's outstanding and overdue, finished work waiting
 * for an invoice, and every invoice by status. Everything here can also be done by asking the assistant.
 */
export default async function InvoicesPage({ searchParams }: { searchParams: Search }) {
  const caller = await pagePrivileged();
  const { status: rawStatus, q, before, after } = await searchParams;
  const status = isInvoiceFilter(rawStatus) ? rawStatus : undefined;
  const query = q?.trim() ?? "";
  const { invoices, totals, ready, hasOlder, hasNewer } = await invoicesFor(caller, {
    status,
    query,
    before: parseInvoiceCursor(before),
    after: parseInvoiceCursor(after),
  });
  const { language } = caller;
  const copy = pageCopyFor(language);
  const t = copy.invoices;
  const canAct = caller.memberId !== null;

  // A tab starts from the newest; paging keeps the tab and the search words.
  const href = (next: InvoiceFilter | undefined, page?: { before?: number; after?: number }) => {
    const params = new URLSearchParams();
    if (next) params.set("status", next);
    if (query) params.set("q", query);
    if (page?.before !== undefined) params.set("before", String(page.before));
    if (page?.after !== undefined) params.set("after", String(page.after));
    const s = params.toString();
    return s ? `/invoices?${s}` : "/invoices";
  };
  const counts: Record<(typeof INVOICE_FILTERS)[number], number> = {
    draft: totals.counts.draft,
    open: totals.counts.open,
    overdue: totals.counts.overdue,
    paid: totals.counts.paid,
    void: totals.counts.void,
  };
  const tabs = [{ key: undefined, label: t.all, count: totals.counts.all }, ...INVOICE_FILTERS.map((key) => ({ key, label: t.filters[key], count: counts[key] }))];

  return (
    <PaperPage
      actions={
        <>
          <MoneyTabs active="invoices" language={language} />
          <AskAssistantButton label={copyFor(language).rail.ask} start={{ topic: "billing" }} />
          {caller.memberId !== null ? <NewInvoiceButton language={language} /> : null}
        </>
      }
      title={t.title}
    >
      <PageBody>
        {caller.memberId === null ? <ViewingNotice language={language} /> : null}
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat help={t.outstandingHelp(totals.counts.open)} label={t.outstanding} value={money(totals.outstandingCents, language)} />
          <Stat help={t.overdueHelp(totals.counts.overdue)} label={t.overdue} tone={totals.overdueCents > 0 ? "red" : undefined} value={money(totals.overdueCents, language)} />
          <Stat help={t.draftsHelp} label={t.drafts} value={totals.counts.draft} />
        </div>

        {ready.length > 0 ? (
          <Card description={t.readyHelp} flush title={t.ready}>
            <ul className="divide-y divide-line">
              {ready.map((job) => (
                <li className="flex flex-wrap items-center gap-3 px-4 py-2.5" key={job.jobId}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-ink">{job.title}</p>
                    <p className="truncate text-[12px] text-ink-3">
                      {job.customerName ?? t.noCustomer}
                      {" · "}
                      {job.quoteTotalCents !== null ? `${t.quoteTotal} ${money(job.quoteTotalCents, language)}` : t.noQuote}
                    </p>
                  </div>
                  {canAct ? <CreateInvoiceButton about={{ serviceJobId: job.jobId }} language={language} needsLines={!job.quoteId} /> : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {totals.counts.all === 0 ? (
          <EmptyState icon={<ReceiptText size={18} />}>{t.empty}</EmptyState>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              <nav aria-label={t.title} className="-mx-1 flex gap-1 overflow-x-auto px-1 py-0.5" style={{ scrollbarWidth: "none" }}>
                {tabs.map((tab) => {
                  const active = tab.key === status;
                  return (
                    <Link
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] transition-colors",
                        active ? "bg-surface font-medium text-ink shadow-hairline" : "text-ink-2 hover:bg-hover",
                      )}
                      href={href(tab.key)}
                      key={tab.key ?? "all"}
                      scroll={false}
                    >
                      {tab.label}
                      <span className="text-[12px] text-ink-3 tabular-nums">{tab.count}</span>
                    </Link>
                  );
                })}
              </nav>
              <SearchBox label={copy.common.search} placeholder={t.searchPlaceholder} />
            </div>
            <Card flush>
              {invoices.length === 0 ? (
                <Nothing>{t.noMatch}</Nothing>
              ) : (
                <Table
                  head={
                    <>
                      <Th>{t.columns.invoice}</Th>
                      <Th className="hidden @2xl:table-cell">{t.columns.customer}</Th>
                      <Th className="text-right">{t.columns.total}</Th>
                      <Th className="text-right">{t.columns.balance}</Th>
                      <Th>{t.columns.status}</Th>
                      <Th className="hidden @xl:table-cell">{t.columns.due}</Th>
                    </>
                  }
                >
                  {invoices.map((invoice) => (
                    <LinkRow
                      href={`/invoices/${invoice.id}`}
                      key={invoice.id}
                      label={
                        <>
                          <span className="block tabular-nums">{invoice.label}</span>
                          <span className="block max-w-[28ch] truncate text-[12px] font-normal text-ink-3">{invoice.title}</span>
                        </>
                      }
                    >
                      <Td className="hidden @2xl:table-cell">{invoice.customerName ?? <span className="text-ink-3">{t.noCustomer}</span>}</Td>
                      <Td className="text-right whitespace-nowrap tabular-nums">{money(invoice.totalCents, language)}</Td>
                      <Td className="text-right whitespace-nowrap tabular-nums">
                        {invoice.status === "void" ? <span className="text-ink-3">—</span> : money(invoice.balanceCents, language)}
                      </Td>
                      <Td>
                        <InvoiceStatusPill language={language} overdue={invoice.overdue} status={invoice.status} />
                      </Td>
                      <Td className={cn("hidden whitespace-nowrap @xl:table-cell", invoice.overdue ? "text-red" : "text-ink-2")}>
                        {invoice.dueDate
                          ? invoice.dueDate === invoice.issueDate
                            ? t.dueOnReceipt
                            : formatDateOnlyShort(invoice.dueDate, language)
                          : <span className="text-ink-3">{t.notSent}</span>}
                      </Td>
                    </LinkRow>
                  ))}
                </Table>
              )}
            </Card>
            {invoices.length > 0 && (hasOlder || hasNewer) ? (
              <nav aria-label={t.paging} className="flex justify-end gap-1 text-[13px]">
                {hasNewer ? (
                  <Link className={pagerClass} href={href(status, { after: invoices[0].number })} rel="prev" scroll={false}>
                    {copy.quotes.newer}
                  </Link>
                ) : null}
                {hasOlder ? (
                  <Link className={pagerClass} href={href(status, { before: invoices.at(-1)!.number })} rel="next" scroll={false}>
                    {copy.quotes.older}
                  </Link>
                ) : null}
              </nav>
            ) : null}
          </>
        )}
      </PageBody>
    </PaperPage>
  );
}

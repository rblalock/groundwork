import Link from "next/link";
import { FileText } from "lucide-react";
import { Card, LinkRow, Nothing, PageBody, QuoteStatusPill, Table, Td, Th, ViewingNotice } from "@/components/pages/kit";
import { SearchBox } from "@/components/pages/client-kit";
import { EmptyState, PaperPage } from "@/components/paper";
import { getProfile } from "@/core/profile";
import { formatDate, money } from "@/lib/format";
import { pageCopyFor } from "@/lib/page-copy";
import { pageMember } from "@/lib/page-session";
import { quoteCursor, type QuoteCursor } from "@/core/quotes";
import { formatQuoteCursor, isQuoteStatus, parseQuoteCursor, QUOTE_STATUSES, quotesFor, type QuoteStatus } from "@/lib/pages/quotes";
import { cn } from "@/ui/lib/utils";
import { AskAssistantButton } from "@/components/threads/thread-rail";
import { copyFor } from "@/lib/copy";

const pagerClass = "flex h-7 items-center rounded-full bg-surface px-3 text-ink shadow-hairline transition-colors hover:bg-hover";

type Search = Promise<{ status?: string; q?: string; before?: string; after?: string }>;

export default async function QuotesPage({ searchParams }: { searchParams: Search }) {
  const caller = await pageMember();
  const { status: rawStatus, q, before, after } = await searchParams;
  const status = isQuoteStatus(rawStatus) ? rawStatus : undefined;
  const query = q?.trim() ?? "";
  const [{ quotes, counts, from, hasOlder, hasNewer, matching }, profile] = await Promise.all([
    quotesFor(caller, { status, query, before: parseQuoteCursor(before), after: parseQuoteCursor(after) }),
    getProfile(caller.orgId),
  ]);
  const { language } = caller;
  const copy = pageCopyFor(language);
  const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);

  // A tab starts from its first page; paging keeps the tab and the search words.
  const href = (next: QuoteStatus | undefined, page?: { before?: QuoteCursor; after?: QuoteCursor }) => {
    const params = new URLSearchParams();
    if (next) params.set("status", next);
    if (query) params.set("q", query);
    if (page?.before) params.set("before", formatQuoteCursor(page.before));
    if (page?.after) params.set("after", formatQuoteCursor(page.after));
    const s = params.toString();
    return s ? `/quotes?${s}` : "/quotes";
  };
  const tabs: Array<{ key: QuoteStatus | undefined; label: string; count: number }> = [
    { key: undefined, label: copy.quotes.all, count: total },
    ...QUOTE_STATUSES.map((key) => ({ key, label: copy.quotes.filters[key], count: counts[key] ?? 0 })),
  ];

  return (
    <PaperPage
      actions={<AskAssistantButton icon="new" label={copyFor(language).rail.newQuote} start={{ topic: "quote" }} variant="primary" />}
      title={copy.quotes.title}
    >
      <PageBody>
        {caller.memberId === null ? <ViewingNotice language={language} /> : null}
        {total === 0 ? (
          <EmptyState icon={<FileText size={18} />}>{copy.quotes.empty}</EmptyState>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              <nav aria-label={copy.quotes.title} className="-mx-1 flex gap-1 overflow-x-auto px-1 py-0.5" style={{ scrollbarWidth: "none" }}>
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
              <SearchBox label={copy.common.search} placeholder={copy.quotes.searchPlaceholder} />
            </div>
            <Card flush>
              {quotes.length === 0 ? (
                <Nothing>
                  {before || after ? (
                    <Link className="underline underline-offset-2" href={href(status)}>
                      {copy.quotes.backToNewest}
                    </Link>
                  ) : (
                    copy.quotes.noMatch
                  )}
                </Nothing>
              ) : (
                <Table
                  head={
                    <>
                      <Th>{copy.quotes.columns.quote}</Th>
                      <Th className="hidden @2xl:table-cell">{copy.quotes.columns.customer}</Th>
                      <Th className="text-right">{copy.quotes.columns.total}</Th>
                      <Th>{copy.quotes.columns.status}</Th>
                      <Th className="hidden @xl:table-cell">{copy.quotes.columns.updated}</Th>
                      <Th className="hidden @3xl:table-cell">{copy.quotes.columns.createdBy}</Th>
                    </>
                  }
                >
                  {quotes.map((quote) => (
                    <LinkRow
                      href={`/quotes/${quote.quoteId}`}
                      key={quote.quoteId}
                      label={
                        <>
                          <span className="block max-w-[28ch] truncate">{quote.title}</span>
                          <span className="block text-[12px] font-normal text-ink-3 md:hidden">
                            {quote.customerName ?? copy.quotes.noCustomer}
                          </span>
                        </>
                      }
                    >
                      <Td className="hidden @2xl:table-cell">
                        {quote.customerName ?? <span className="text-ink-3">{copy.quotes.noCustomer}</span>}
                        {quote.propertyAddress ? (
                          <span className="block max-w-[30ch] truncate text-[12px] text-ink-3">{quote.propertyAddress}</span>
                        ) : null}
                      </Td>
                      <Td className="text-right whitespace-nowrap tabular-nums">
                        {quote.state === "ready" ? money(quote.totalCents, language) : <span className="text-ink-3">{copy.quotes.notPriced}</span>}
                      </Td>
                      <Td>
                        <QuoteStatusPill language={language} status={quote.status} />
                      </Td>
                      <Td className="hidden whitespace-nowrap text-ink-2 @xl:table-cell">{formatDate(quote.updatedAt, language, profile.timeZone)}</Td>
                      <Td className="hidden text-ink-2 @3xl:table-cell">{quote.createdBy}</Td>
                    </LinkRow>
                  ))}
                </Table>
              )}
            </Card>
            {quotes.length > 0 && (hasOlder || hasNewer) ? (
              <nav aria-label={copy.quotes.paging} className="flex items-center justify-between gap-3 text-[13px]">
                <span className="text-ink-3 tabular-nums">
                  {copy.quotes.range(from, from + quotes.length - 1, matching)}
                </span>
                <span className="flex gap-1">
                  {hasNewer ? (
                    <Link className={pagerClass} href={href(status, { after: quoteCursor(quotes[0]) })} rel="prev" scroll={false}>
                      {copy.quotes.newer}
                    </Link>
                  ) : null}
                  {hasOlder ? (
                    <Link className={pagerClass} href={href(status, { before: quoteCursor(quotes.at(-1)!) })} rel="next" scroll={false}>
                      {copy.quotes.older}
                    </Link>
                  ) : null}
                </span>
              </nav>
            ) : null}
          </>
        )}
      </PageBody>
    </PaperPage>
  );
}

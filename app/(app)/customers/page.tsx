import Link from "next/link";
import { Users } from "lucide-react";
import { SearchBox } from "@/components/pages/client-kit";
import { NewCustomerButton } from "@/components/pages/customer-editors";
import { Card, LinkRow, Nothing, PageBody, Table, Td, Th, ViewingNotice } from "@/components/pages/kit";
import { EmptyState, PaperPage } from "@/components/paper";
import { getProfile } from "@/core/profile";
import { formatDate, formatPhone } from "@/lib/format";
import { pageCopyFor } from "@/lib/page-copy";
import { pageMember } from "@/lib/page-session";
import { customerCursor, type CustomerCursor } from "@/core/customers";
import { customerListFor, formatCustomerCursor, parseCustomerCursor } from "@/lib/pages/customers";
import { AskAssistantButton } from "@/components/threads/thread-rail";
import { copyFor } from "@/lib/copy";

const pagerClass = "flex h-7 items-center rounded-full bg-surface px-3 text-ink shadow-hairline transition-colors hover:bg-hover";

type Search = Promise<{ q?: string; before?: string; after?: string }>;

export default async function CustomersPage({ searchParams }: { searchParams: Search }) {
  const caller = await pageMember();
  const { q, before, after } = await searchParams;
  const query = q?.trim() ?? "";
  const [{ customers, hasOlder, hasNewer, any }, profile] = await Promise.all([
    customerListFor(caller, { query, before: parseCustomerCursor(before), after: parseCustomerCursor(after) }),
    getProfile(caller.orgId),
  ]);
  const paged = !query && Boolean(before || after);
  const href = (page?: { before?: CustomerCursor; after?: CustomerCursor }) => {
    const params = new URLSearchParams();
    if (page?.before) params.set("before", formatCustomerCursor(page.before));
    if (page?.after) params.set("after", formatCustomerCursor(page.after));
    const s = params.toString();
    return s ? `/customers?${s}` : "/customers";
  };
  const { language } = caller;
  const copy = pageCopyFor(language);
  const c = copy.customers;

  return (
    <PaperPage
      actions={
        <div className="flex items-center gap-1">
          {caller.memberId !== null ? <NewCustomerButton businessLanguage={profile.language} language={language} /> : null}
          <AskAssistantButton label={copyFor(language).rail.ask} start={{ topic: "customer" }} />
        </div>
      }
      title={c.title}
    >
      <PageBody>
        {caller.memberId === null ? <ViewingNotice language={language} /> : null}
        {!any ? (
          <EmptyState icon={<Users size={18} />}>{c.empty}</EmptyState>
        ) : (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span />
              <SearchBox label={copy.common.search} placeholder={c.searchPlaceholder} />
            </div>
            <Card flush>
              {customers.length === 0 ? (
                <Nothing>
                  {paged ? (
                    <Link className="underline underline-offset-2" href={href()}>
                      {c.backToNewest}
                    </Link>
                  ) : (
                    c.noMatch
                  )}
                </Nothing>
              ) : (
                <Table
                  head={
                    <>
                      <Th>{c.columns.name}</Th>
                      <Th className="hidden @xl:table-cell">{c.columns.phones}</Th>
                      <Th className="hidden @2xl:table-cell">{c.columns.emails}</Th>
                      <Th className="text-right">{c.columns.quotes}</Th>
                      <Th className="hidden @xl:table-cell">{c.columns.lastActivity}</Th>
                    </>
                  }
                >
                  {customers.map((customer) => (
                    <LinkRow
                      href={`/customers/${customer.id}`}
                      key={customer.id}
                      label={
                        <>
                          {customer.name}
                          {customer.phones[0] ? (
                            <span className="block text-[12px] font-normal text-ink-3 tabular-nums sm:hidden">{formatPhone(customer.phones[0])}</span>
                          ) : null}
                        </>
                      }
                    >
                      <Td className="hidden tabular-nums @xl:table-cell">
                        {customer.phones.length ? customer.phones.map((p) => <span className="block" key={p}>{formatPhone(p)}</span>) : <span className="text-ink-3">{copy.common.none}</span>}
                      </Td>
                      <Td className="hidden @2xl:table-cell">
                        {customer.emails.length ? customer.emails.map((e) => <span className="block break-all" key={e}>{e}</span>) : <span className="text-ink-3">{copy.common.none}</span>}
                      </Td>
                      <Td className="text-right tabular-nums">{customer.quoteCount}</Td>
                      <Td className="hidden whitespace-nowrap text-ink-2 @xl:table-cell">{formatDate(customer.lastActivityAt, language, profile.timeZone)}</Td>
                    </LinkRow>
                  ))}
                </Table>
              )}
            </Card>
            {customers.length > 0 && (hasOlder || hasNewer) ? (
              <nav aria-label={c.paging} className="flex items-center justify-end gap-1 text-[13px]">
                {hasNewer ? (
                  <Link className={pagerClass} href={href({ after: customerCursor(customers[0]) })} rel="prev" scroll={false}>
                    {c.newer}
                  </Link>
                ) : null}
                {hasOlder ? (
                  <Link className={pagerClass} href={href({ before: customerCursor(customers.at(-1)!) })} rel="next" scroll={false}>
                    {c.older}
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

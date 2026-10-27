import { Users } from "lucide-react";
import { SearchBox } from "@/components/pages/client-kit";
import { Card, LinkRow, Nothing, PageBody, Table, Td, Th, ViewingNotice } from "@/components/pages/kit";
import { EmptyState, PaperPage } from "@/components/paper";
import { getProfile } from "@/core/profile";
import { formatDate, formatPhone } from "@/lib/format";
import { pageCopyFor } from "@/lib/page-copy";
import { pageMember } from "@/lib/page-session";
import { customersFor } from "@/lib/pages/customers";
import { AskAssistantButton } from "@/components/threads/thread-rail";
import { copyFor } from "@/lib/copy";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const caller = await pageMember();
  const query = (await searchParams).q?.trim() ?? "";
  const [customers, profile] = await Promise.all([customersFor(caller, query), getProfile(caller.orgId)]);
  // Whether there are any at all, so an empty search isn't mistaken for an empty business.
  const any = query ? (await customersFor(caller)).length > 0 : customers.length > 0;
  const { language } = caller;
  const copy = pageCopyFor(language);
  const c = copy.customers;

  return (
    <PaperPage
      actions={<AskAssistantButton icon="new" label={copyFor(language).rail.newCustomer} start={{ topic: "customer" }} />}
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
                <Nothing>{c.noMatch}</Nothing>
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
          </>
        )}
      </PageBody>
    </PaperPage>
  );
}

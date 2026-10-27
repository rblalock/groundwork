import Link from "next/link";
import { Banknote } from "lucide-react";
import { RecordPaymentButton } from "@/components/invoices/actions";
import { MoneyTabs } from "@/components/invoices/kit";
import { AskAssistantButton } from "@/components/threads/thread-rail";
import { getProfile } from "@/core/profile";
import { todayYmd } from "@/core/time";
import { copyFor } from "@/lib/copy";
import { Card, PageBody, Table, Td, Th, ViewingNotice } from "@/components/pages/kit";
import { EmptyState, PaperPage } from "@/components/paper";
import { formatDateOnlyShort, money } from "@/lib/format";
import { pageCopyFor } from "@/lib/page-copy";
import { pagePrivileged } from "@/lib/page-session";
import { formatPaymentCursor, invoicesFor, parsePaymentCursor, paymentsFor } from "@/lib/pages/invoices";

const pagerClass = "flex h-7 items-center rounded-full bg-surface px-3 text-ink shadow-hairline transition-colors hover:bg-hover";

/** Money received, newest first, a page at a time: recorded by hand or paid online. Owners and admins. */
export default async function PaymentsPage({ searchParams }: { searchParams: Promise<{ before?: string; after?: string }> }) {
  const caller = await pagePrivileged();
  const { before, after } = await searchParams;
  const [{ payments, receivedCents, older, newer }, open, profile] = await Promise.all([
    paymentsFor(caller, { before: parsePaymentCursor(before), after: parsePaymentCursor(after) }),
    caller.memberId !== null ? invoicesFor(caller, { status: "open" }, 100) : null,
    getProfile(caller.orgId),
  ]);
  const openInvoices = (open?.invoices ?? []).map((invoice) => ({
    invoiceId: invoice.id,
    label: invoice.label,
    title: invoice.title,
    customerName: invoice.customerName,
    balanceCents: invoice.balanceCents,
  }));
  const { language } = caller;
  const copy = pageCopyFor(language);
  const p = copy.payments;
  const total = receivedCents;
  return (
    <PaperPage
      actions={
        <>
          <MoneyTabs active="payments" language={language} />
          <AskAssistantButton label={copyFor(language).rail.ask} start={{ topic: "billing" }} />
          <RecordPaymentButton invoices={openInvoices} language={language} today={todayYmd(profile.timeZone)} />
        </>
      }
      title={p.title}
    >
      <PageBody>
        {caller.memberId === null ? <ViewingNotice language={language} /> : null}
        {payments.length === 0 ? (
          <EmptyState icon={<Banknote size={18} />}>{p.empty}</EmptyState>
        ) : (
          <>
            <p className="text-[13px] text-ink-2 tabular-nums">{p.total(money(total, language))}</p>
            <Card flush>
              <Table
                head={
                  <>
                    <Th>{p.columns.date}</Th>
                    <Th>{p.columns.invoice}</Th>
                    <Th className="hidden @2xl:table-cell">{p.columns.customer}</Th>
                    <Th>{p.columns.method}</Th>
                    <Th className="text-right">{p.columns.amount}</Th>
                    <Th className="hidden @3xl:table-cell">{p.columns.by}</Th>
                  </>
                }
              >
                {payments.map((row) => (
                  <tr className="relative transition-colors hover:bg-hover" key={row.id}>
                    <Td className="whitespace-nowrap text-ink-2">{formatDateOnlyShort(row.receivedDate, language)}</Td>
                    <Td>
                      <Link
                        className="font-medium tabular-nums text-ink after:absolute after:inset-0"
                        href={row.invoiceId ? `/invoices/${row.invoiceId}` : `/quotes/${row.quoteId}`}
                      >
                        {row.invoiceLabel ?? p.deposit}
                      </Link>
                      <span className="block max-w-[28ch] truncate text-[12px] text-ink-3">{row.invoiceTitle}</span>
                    </Td>
                    <Td className="hidden @2xl:table-cell">{row.customerName ?? <span className="text-ink-3">{copy.invoices.noCustomer}</span>}</Td>
                    <Td>{row.source === "stripe" ? p.online : copy.invoices.methods[row.method]}</Td>
                    <Td className="text-right whitespace-nowrap tabular-nums">
                      {money(row.amountCents, language)}
                      {row.refundedCents > 0 ? <span className="block text-[12px] text-ink-3">{copy.invoices.refundedSome(money(row.refundedCents, language))}</span> : null}
                    </Td>
                    <Td className="hidden text-ink-2 @3xl:table-cell">{row.recordedBy ?? "Stripe"}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
            {older || newer ? (
              <nav aria-label={p.paging} className="flex justify-end gap-1 text-[13px]">
                {newer ? (
                  <Link className={pagerClass} href={`/invoices/payments?after=${encodeURIComponent(formatPaymentCursor(newer))}`} rel="prev" scroll={false}>
                    {copy.quotes.newer}
                  </Link>
                ) : null}
                {older ? (
                  <Link className={pagerClass} href={`/invoices/payments?before=${encodeURIComponent(formatPaymentCursor(older))}`} rel="next" scroll={false}>
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

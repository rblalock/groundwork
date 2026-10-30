import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, FileText } from "lucide-react";
import { CopyButton, InvoiceActions, RemovePaymentButton } from "@/components/invoices/actions";
import { InvoicePhotos } from "@/components/invoices/photos";
import { BeforeAfterCard } from "@/components/quotes/before-after-card";
import { InvoiceStatusPill } from "@/components/invoices/kit";
import { AskAssistantButton } from "@/components/threads/thread-rail";
import { copyFor } from "@/lib/copy";
import { Card, Crumb, PageBody, Table, Td, Th, ViewingNotice } from "@/components/pages/kit";
import { JumpBar, type JumpSection } from "@/components/record/jump-bar";
import { EmptyFold, RailFact, RecordColumns, RecordSection } from "@/components/record/layout";
import { ProgressLine } from "@/components/record/progress-line";
import { PaperPage } from "@/components/paper";
import { OnScreen } from "@/components/threads/on-screen";
import type { Language } from "@/core/language";
import { getCustomer } from "@/core/customers";
import { cardText, INVOICE_PHOTO_LIMIT } from "@/core/invoices";
import { getProfile } from "@/core/profile";
import { takesCardPayments } from "@/core/stripe-connection";
import { todayYmd } from "@/core/time";
import { formatDate, formatDateOnlyShort, money, quantity } from "@/lib/format";
import { HttpError } from "@/lib/guards";
import { pageCopyFor } from "@/lib/page-copy";
import { pagePrivileged } from "@/lib/page-session";
import { invoiceBeforeAfterFor, invoiceFor, invoicePhotosFor } from "@/lib/pages/invoices";
import { invoiceProgress } from "@/lib/record-progress";

function signed(cents: number, language: Language) {
  return `${cents < 0 ? "−" : "+"}${money(Math.abs(cents), language)}`;
}

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const caller = await pagePrivileged();
  const { id } = await params;
  const invoice = await invoiceFor(caller, id).catch((error: unknown) => {
    if (error instanceof HttpError && error.status === 404) notFound();
    throw error;
  });
  const [profile, cards, customer, photos, beforeAfter] = await Promise.all([
    getProfile(caller.orgId),
    takesCardPayments(caller.orgId),
    invoice.customerId ? getCustomer(caller.orgId, invoice.customerId) : null,
    invoicePhotosFor(caller, invoice),
    invoiceBeforeAfterFor(caller, invoice),
  ]);
  const { language } = caller;
  const copy = pageCopyFor(language);
  const t = copy.invoices;
  const tz = profile.timeZone;
  const canAct = caller.memberId !== null;
  const livePayments = invoice.payments.filter((p) => !p.removedAt);
  const dueText = invoice.dueDate ? (invoice.dueDate === invoice.issueDate ? t.dueOnReceipt : formatDateOnlyShort(invoice.dueDate, language)) : null;
  const r = copy.record;
  const onPdf = photos.filter((p) => p.onPdf).length;
  const sections: JumpSection[] = [
    { id: "lines", label: t.lines, count: invoice.lines.length },
    ...(invoice.payments.length > 0 ? [{ id: "payments", label: t.payments, count: livePayments.length }] : []),
    ...(beforeAfter ? [{ id: "before-after", label: copy.quotes.beforeAfter }] : []),
    ...(photos.length > 0 ? [{ id: "photos", label: t.photos, count: photos.length }] : []),
    ...(invoice.notes ? [{ id: "notes", label: copy.customers.notes }] : []),
  ];

  return (
    <>
      <OnScreen record={{ kind: "invoice", id: invoice.id, label: `${invoice.label} · ${invoice.title}` }} />
      <PaperPage
        actions={invoice.status !== "void" ? <AskAssistantButton label={copyFor(language).rail.ask} start={{ invoiceId: invoice.id, reuse: true }} /> : null}
        title={<Crumb href="/invoices" parent={t.back}>{invoice.label}</Crumb>}
      >
        <PageBody>
          {caller.memberId === null ? <ViewingNotice language={language} /> : null}

          <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-ink tabular-nums">{invoice.label}</h2>
                <InvoiceStatusPill language={language} overdue={invoice.overdue} status={invoice.status} />
              </div>
              <p className="text-[13px] text-ink-2 text-pretty">
                {invoice.title}
                {invoice.customerName && invoice.customerName !== invoice.title ? ` · ${invoice.customerName}` : ""}
              </p>
            </div>
            <div className="shrink-0 sm:text-right">
              <p className="text-[12px] text-ink-3">{invoice.status === "void" ? t.total : t.balanceDue}</p>
              <p className={`text-2xl font-semibold tabular-nums ${invoice.overdue ? "text-red" : "text-ink"}`}>
                {money(invoice.status === "void" ? invoice.totalCents : invoice.balanceCents, language)}
              </p>
              {invoice.status !== "void" && invoice.amountPaidCents > 0 ? (
                <p className="text-[12px] text-ink-3 tabular-nums">
                  {t.total} {money(invoice.totalCents, language)} · {t.paid} {money(invoice.amountPaidCents, language)}
                </p>
              ) : null}
            </div>
          </header>

          <ProgressLine nextLabel={r.next} stages={invoiceProgress(invoice.status, r.invoiceStages)} />

          {canAct ? (
            <InvoiceActions
              balanceCents={invoice.balanceCents}
              dueDate={invoice.dueDate}
              hasPayments={livePayments.length > 0}
              invoiceId={invoice.id}
              language={language}
              lines={invoice.lines.map((l) => ({ name: l.name, quantity: l.quantity, unitLabel: l.unitLabel, unitCents: l.unitCents, taxable: l.taxable }))}
              notes={invoice.notes}
              payUrl={invoice.payUrl}
              status={invoice.status}
              today={todayYmd(tz)}
            />
          ) : null}

          {invoice.overpaidCents > 0 ? (
            <p className="rounded-card bg-orange-tint px-4 py-3 text-[13px] text-orange" role="status">
              {t.overpaid(money(invoice.overpaidCents, language))}
            </p>
          ) : null}

          {sections.length >= 3 ? <JumpBar label={r.sections} sections={sections} /> : null}

          <RecordColumns
            main={
              <>
                <RecordSection id="lines">
                  <Card description={invoice.quoteId ? t.fromQuote : undefined} flush title={t.lines}>
                    <Table
                      head={
                        <>
                          <Th>{t.item}</Th>
                          <Th className="text-right">{t.quantity}</Th>
                          <Th className="text-right">{t.unitPrice}</Th>
                          <Th className="text-right">{t.amount}</Th>
                        </>
                      }
                    >
                      {invoice.lines.map((line, index) => (
                        <tr key={`${line.name}-${index}`}>
                          <Td>
                            <span className="font-medium">{line.name}</span>
                            {line.unitLabel || (!line.taxable && invoice.taxCents > 0) ? (
                              <span className="block text-[12px] text-ink-3">
                                {[line.unitLabel, !line.taxable && invoice.taxCents > 0 ? t.noTax : null].filter(Boolean).join(" · ")}
                              </span>
                            ) : null}
                          </Td>
                          <Td className="text-right tabular-nums">{quantity(line.quantity)}</Td>
                          <Td className="text-right whitespace-nowrap tabular-nums">{money(line.unitCents, language)}</Td>
                          <Td className="text-right whitespace-nowrap tabular-nums">{money(line.totalCents, language)}</Td>
                        </tr>
                      ))}
                    </Table>
                    <dl className="space-y-1.5 border-t border-line px-4 py-3 text-[13px]">
                      <div className="flex justify-between gap-4">
                        <dt className="text-ink-2">{t.subtotal}</dt>
                        <dd className="tabular-nums">{money(invoice.subtotalCents - invoice.ruleLines.reduce((s, r) => s + r.cents, 0), language)}</dd>
                      </div>
                      {invoice.ruleLines.map((rule) => (
                        <div className="flex justify-between gap-4" key={rule.ruleId}>
                          <dt className="text-ink-2">{rule.label}</dt>
                          <dd className="tabular-nums">{signed(rule.cents, language)}</dd>
                        </div>
                      ))}
                      {invoice.minimumAppliedCents > 0 ? (
                        <div className="flex justify-between gap-4">
                          <dt className="text-ink-2">{t.minimum}</dt>
                          <dd className="tabular-nums">{signed(invoice.minimumAppliedCents, language)}</dd>
                        </div>
                      ) : null}
                      {invoice.adjustmentCents !== 0 ? (
                        <div className="flex justify-between gap-4">
                          <dt className="text-ink-2">{t.adjustment}</dt>
                          <dd className="tabular-nums">{signed(invoice.adjustmentCents, language)}</dd>
                        </div>
                      ) : null}
                      {invoice.taxCents > 0 ? (
                        <div className="flex justify-between gap-4">
                          <dt className="text-ink-2">{t.tax}</dt>
                          <dd className="tabular-nums">{signed(invoice.taxCents, language)}</dd>
                        </div>
                      ) : null}
                      <div className="flex justify-between gap-4 pt-1 text-sm font-semibold">
                        <dt>{t.total}</dt>
                        <dd className="tabular-nums">{money(invoice.totalCents, language)}</dd>
                      </div>
                      {invoice.amountPaidCents > 0 ? (
                        <>
                          <div className="flex justify-between gap-4">
                            <dt className="text-ink-2">{t.paid}</dt>
                            <dd className="tabular-nums">−{money(invoice.amountPaidCents, language)}</dd>
                          </div>
                          <div className="flex justify-between gap-4 text-sm font-semibold">
                            <dt>{t.balanceDue}</dt>
                            <dd className="tabular-nums">{money(invoice.balanceCents, language)}</dd>
                          </div>
                        </>
                      ) : null}
                    </dl>
                  </Card>
                </RecordSection>

                {invoice.payments.length > 0 ? (
                  <RecordSection id="payments">
                    <Card flush title={t.payments}>
                    <ul className="divide-y divide-line">
                      {invoice.payments.map((payment) => (
                        <li className={`flex items-center gap-3 px-4 py-2.5 text-[13px] ${payment.removedAt ? "opacity-55" : ""}`} key={payment.id}>
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-ink">
                              {payment.source === "stripe" ? t.online : t.methods[payment.method]}
                              {cardText(payment) ? <span className="font-normal text-ink-3"> · {cardText(payment)}</span> : null}
                              {payment.reference && payment.source !== "stripe" ? <span className="font-normal text-ink-3"> · {payment.reference}</span> : null}
                              {payment.removedAt ? (
                                <span className="font-normal text-ink-3"> · {payment.refundedCents > 0 && !payment.removedByMemberId ? t.refunded : t.removed}</span>
                              ) : payment.refundedCents > 0 ? (
                                <span className="font-normal text-ink-3"> · {t.refundedSome(money(payment.refundedCents, language))}</span>
                              ) : null}
                            </p>
                            <p className="text-[12px] text-ink-3">
                              {formatDateOnlyShort(payment.receivedDate, language)}
                              {payment.recordedBy ? ` · ${t.recordedBy(payment.recordedBy)}` : ""}
                            </p>
                          </div>
                          <span className={`tabular-nums ${payment.removedAt ? "line-through" : ""}`}>{money(payment.amountCents, language)}</span>
                          {canAct && payment.source === "manual" && !payment.removedAt ? (
                            <RemovePaymentButton invoiceId={invoice.id} language={language} paymentId={payment.id} />
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    </Card>
                  </RecordSection>
                ) : (
                  <EmptyFold actions={null}>{t.noPayments}</EmptyFold>
                )}

                {beforeAfter ? (
                  <RecordSection id="before-after">
                    <BeforeAfterCard
                      actions={
                        <Link className="shrink-0 text-[12px] font-medium text-accent-ink hover:underline" href={`/quotes/${beforeAfter.quoteId}#before-after`}>
                          {t.shareFromQuote}
                        </Link>
                      }
                      description={t.beforeAfterHelp}
                      href={beforeAfter.href}
                      language={language}
                      quoteHref={`/quotes/${beforeAfter.quoteId}`}
                    />
                  </RecordSection>
                ) : null}

                {photos.length > 0 ? (
                  <RecordSection id="photos">
                    <Card actions={onPdf > 0 ? <span className="text-[12px] text-ink-3">{t.photosOnPdf(onPdf)}</span> : null} title={t.photos}>
                      <InvoicePhotos
                        key={photos.filter((p) => p.onPdf).map((p) => p.id).join()}
                        canChoose={canAct && invoice.status !== "void"}
                        invoiceId={invoice.id}
                        jobId={photos[0].jobId}
                        language={language}
                        limit={INVOICE_PHOTO_LIMIT}
                        photos={photos.map((p) => ({ id: p.id, description: p.description, onPdf: p.onPdf }))}
                      />
                    </Card>
                  </RecordSection>
                ) : null}

                {invoice.notes ? (
                  <RecordSection id="notes">
                    <Card title={copy.customers.notes}>
                      <p className="text-[13px] whitespace-pre-line text-ink">{invoice.notes}</p>
                    </Card>
                  </RecordSection>
                ) : null}
              </>
            }
            rail={
              <>
                <RailFact label={t.customer}>
                  {customer ? (
                    <div className="space-y-1">
                      <Link className="block font-medium text-accent-ink hover:underline" href={`/customers/${customer.id}`}>
                        {customer.name}
                      </Link>
                      {customer.emails.map((email) => (
                        <a className="block break-all text-ink-2 hover:underline" href={`mailto:${email}`} key={email}>
                          {email}
                        </a>
                      ))}
                      {invoice.address ? <p className="text-ink-2">{invoice.address}</p> : null}
                    </div>
                  ) : (
                    <span className="text-ink-3">{t.noCustomerYet}</span>
                  )}
                </RailFact>

                <RailFact label={t.dates}>
                  <dl className="space-y-1">
                    <div className="flex justify-between gap-3">
                      <dt className="text-ink-2">{t.issued}</dt>
                      <dd className="text-right">{invoice.issueDate ? formatDateOnlyShort(invoice.issueDate, language) : t.notSent}</dd>
                    </div>
                    {dueText ? (
                      <div className="flex justify-between gap-3">
                        <dt className="text-ink-2">{t.due}</dt>
                        <dd className={`text-right ${invoice.overdue ? "text-red" : ""}`}>{dueText}</dd>
                      </div>
                    ) : null}
                    {invoice.paidAt ? (
                      <div className="flex justify-between gap-3">
                        <dt className="text-ink-2">{t.paidOn}</dt>
                        <dd className="text-right">{formatDate(invoice.paidAt, language, tz)}</dd>
                      </div>
                    ) : null}
                    <div className="flex justify-between gap-3">
                      <dt className="text-ink-2">{t.created}</dt>
                      <dd className="text-right">{formatDate(invoice.createdAt, language, tz)}</dd>
                    </div>
                  </dl>
                  <p className="mt-1 text-[12px] text-ink-3">{t.createdBy(invoice.createdBy)}</p>
                </RailFact>

                <RailFact label={t.pdf}>
                  {invoice.pdfUrl ? (
                    <a className="inline-flex items-center gap-1.5 font-medium text-accent-ink hover:underline" href={`/api/invoices/${invoice.id}/pdf`} rel="noopener" target="_blank">
                      <FileText aria-hidden="true" className="size-3.5" />
                      {t.openPdf}
                    </a>
                  ) : (
                    <span className="text-ink-3 text-pretty">{invoice.status === "void" ? t.noPdfVoid : t.noPdf}</span>
                  )}
                </RailFact>

                {invoice.status !== "void" ? (
                  <RailFact label={t.payLink}>
                    {invoice.payUrl ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <CopyButton done={t.copied} label={t.copyLink} text={invoice.payUrl} />
                        <a className="inline-flex items-center gap-1 font-medium text-accent-ink hover:underline" href={invoice.payUrl} rel="noopener" target="_blank">
                          {copy.quotes.openLink}
                          <ExternalLink aria-hidden="true" className="size-3.5" />
                        </a>
                      </div>
                    ) : (
                      <span className="text-ink-3 text-pretty">
                        {invoice.balanceCents === 0 && invoice.status !== "draft" ? t.payLinkPaid : !cards ? t.payLinkNone : t.payLinkDraft}
                      </span>
                    )}
                  </RailFact>
                ) : null}

                {invoice.quoteId || invoice.serviceJobId ? (
                  <RailFact label={t.work}>
                    <div className="space-y-1">
                      {invoice.quoteId ? (
                        <Link className="block font-medium text-accent-ink hover:underline" href={`/quotes/${invoice.quoteId}`}>
                          {t.openQuote}
                        </Link>
                      ) : null}
                      {invoice.serviceJobId ? (
                        <Link className="block font-medium text-accent-ink hover:underline" href={`/work/${invoice.serviceJobId}`}>
                          {copy.work.open}
                        </Link>
                      ) : null}
                    </div>
                  </RailFact>
                ) : null}
              </>
            }
          />
        </PageBody>
      </PaperPage>
    </>
  );
}

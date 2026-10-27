import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, FileText, Paperclip } from "lucide-react";
import { Card, Crumb, PageBody, QuoteStatusPill, Table, Td, Th, ViewingNotice } from "@/components/pages/kit";
import { JobsTable } from "@/components/pages/jobs";
import { QuoteActions } from "@/components/pages/quote-actions";
import { WorkCard } from "@/components/schedule/work-card";
import { PaperPage } from "@/components/paper";
import { OnScreen } from "@/components/threads/on-screen";
import type { Language } from "@/core/language";
import { isPrivileged } from "@/core/members";
import { getProfile } from "@/core/profile";
import type { TimelineEntry } from "@/core/quote-timeline";
import { formatDate, formatDateTime, formatPhone, money, quantity } from "@/lib/format";
import { HttpError } from "@/lib/guards";
import { pageCopyFor, type PageCopy } from "@/lib/page-copy";
import { pageMember } from "@/lib/page-session";
import { jobsOn } from "@/lib/pages/jobs";
import { quoteInvoiceFor } from "@/lib/pages/invoices";
import { quoteFor } from "@/lib/pages/quotes";
import { canEditNote, quoteNotesFor } from "@/lib/pages/notes";
import { NoteEditor } from "@/components/pages/note-editors";
import { NoteList } from "@/components/pages/note-list";
import { CopyButton, CreateInvoiceButton } from "@/components/invoices/actions";
import { InvoiceStatusPill } from "@/components/invoices/kit";
import { workOn } from "@/lib/pages/schedule";
import { AskAssistantButton } from "@/components/threads/thread-rail";
import { QuoteLanguageControl, QuoteText, QuoteTranslationProvider, QuoteViewToggle } from "@/components/quotes/quote-language";
import { mayChangeQuoteLanguage, unitTextId } from "@/lib/pages/quote-language";
import { editorItems } from "@/lib/pages/quote-editor";
import { AddPhotosButton, EditQuoteButton, RemovePhotoButton } from "@/components/quotes/quote-editor";
import { PricePhotoButton } from "@/components/quotes/price-photo-button";
import { copyFor } from "@/lib/copy";
import { JumpBar, type JumpSection } from "@/components/record/jump-bar";
import { EmptyFold, RailFact, RecordColumns, RecordSection } from "@/components/record/layout";
import { ProgressLine } from "@/components/record/progress-line";
import { quoteProgress, shortWhen } from "@/lib/record-progress";

const IMAGE_NAME = /\.(jpe?g|png|gif|webp)$/i;


function signed(cents: number, language: Language) {
  return `${cents < 0 ? "−" : "+"}${money(Math.abs(cents), language)}`;
}

function reasonText(reason: string, copy: PageCopy["quotes"]) {
  const [code, ...rest] = reason.split(":");
  const name = rest.join(":").trim();
  if (code === "unpriced") return copy.priceFor(name);
  if (code === "bad_quantity") return copy.quantityFor(name);
  if (code === "multiple_overrides") return copy.oneOverride;
  if (code === "negative_total") return copy.positiveTotal;
  return reason;
}

function timelineText(entry: TimelineEntry, copy: PageCopy["quotes"], language: Language) {
  const what = (() => {
    switch (entry.kind) {
      case "created":
        return copy.events.created;
      case "revised":
        return copy.events.revised(entry.revision ?? 0);
      case "approved":
        return copy.events.approved(entry.revision);
      case "emailed":
        return copy.events.emailed(entry.to);
      case "customer_approved":
        return copy.events.customer_approved(entry.name);
      case "deposit":
        return copy.events.deposit(money(entry.amountCents ?? 0, language));
      default:
        return copy.events[entry.kind];
    }
  })();
  return `${what}${copy.by(entry.by)}`;
}

export default async function QuoteDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ priced?: string }> }) {
  const caller = await pageMember();
  const { id } = await params;
  const { priced: pricedOutcome } = await searchParams;
  const { quote, timeline, depositPaidCents, pricedPhoto } = await quoteFor(caller, id).catch((error: unknown) => {
    if (error instanceof HttpError && error.status === 404) notFound();
    throw error;
  });
  const [profile, jobs, work, billing, canChangeLanguage, notes] = await Promise.all([
    getProfile(caller.orgId),
    jobsOn(caller, { quoteId: quote.quoteId }),
    workOn(caller, { quoteId: quote.quoteId }),
    quoteInvoiceFor(caller, quote.quoteId, quote.status),
    mayChangeQuoteLanguage(caller, quote),
    quoteNotesFor(caller, quote.quoteId),
  ]);
  const { language } = caller;
  const copy = pageCopyFor(language);
  const q = copy.quotes;
  // Whoever may change its language may edit it: an owner or admin, or the crew member who started it, while it's open.
  const canEdit = canChangeLanguage;
  const items = canEdit ? await editorItems(caller) : [];
  const tz = profile.timeZone;
  const canAct = caller.memberId !== null && isPrivileged(caller.role);
  // Agreed money is work to book: more visits go on its open work, if it has some.
  const openWork = work.find((job) => job.status === "open");
  const bookable = canAct && ["approved", "sent", "won"].includes(quote.status) && (openWork || !work.some((job) => job.status !== "cancelled"));
  const bookHref = bookable ? `/schedule?book=${openWork ? `job:${openWork.id}` : `quote:${quote.quoteId}`}` : undefined;

  // Where it stands, from drafted to paid, naming the next visit while it's booked.
  const r = copy.record;
  const visits = work.flatMap((job) => job.visits).filter((visit) => visit.status !== "cancelled");
  const nextVisit = visits
    .filter((visit) => visit.status !== "completed" && visit.startAt.getTime() > Date.now())
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())[0];
  const stages = quoteProgress(
    {
      status: quote.status,
      hasVisits: visits.length > 0,
      workDone: work.some((job) => job.status === "completed"),
      invoice: billing.invoice?.status ?? null,
      bookedLabel: nextVisit ? r.stages.bookedAt(shortWhen(nextVisit.startAt, language, tz)) : undefined,
    },
    r.stages,
  );
  // The priced photo is made from the quote's latest JPEG or PNG (a quote of PDFs only says so); anyone on the team may make it.
  const hasPhoto = quote.attachments.length > 0;
  const sections: JumpSection[] = [
    { id: "lines", label: q.lines },
    ...(quote.attachments.length > 0 ? [{ id: "photos", label: q.photos, count: quote.attachments.length }] : []),
    ...(hasPhoto || pricedPhoto ? [{ id: "priced-photo", label: q.pricedPhoto }] : []),
    ...(work.length > 0 || bookHref ? [{ id: "work", label: copy.schedule.onRecord, count: visits.length }] : []),
    ...(notes.length > 0 ? [{ id: "notes", label: copy.notes.onQuote, count: notes.length }] : []),
    ...(jobs.length > 0 ? [{ id: "threads", label: copy.jobs.onRecord, count: jobs.length }] : []),
    { id: "timeline", label: q.timeline, count: timeline.length },
  ];

  return (
    <>
      <OnScreen record={{ kind: "quote", id: quote.quoteId, label: quote.title }} />
      <PaperPage
        actions={<AskAssistantButton label={copyFor(language).rail.ask} start={{ quoteId: quote.quoteId, reuse: true }} />}
        title={<Crumb href="/quotes" parent={q.back}>{quote.title}</Crumb>}
      >
        <PageBody>
          <QuoteTranslationProvider quoteId={quote.quoteId} revision={quote.revisionNumber}>
          {caller.memberId === null ? <ViewingNotice language={language} /> : null}

          <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-balance text-ink">
                  <QuoteText id="title" language={language} text={quote.title} />
                </h2>
                <QuoteStatusPill language={language} status={quote.status} />
              </div>
              <p className="text-[13px] text-ink-2">
                {q.revision(quote.revisionNumber)} · {q.startedBy(quote.createdBy, formatDate(quote.updatedAt, language, tz))}
              </p>
              <QuoteLanguageControl
                canChange={canChangeLanguage}
                customer={quote.customer ? { name: quote.customer.name, language: quote.customer.language } : null}
                language={language}
                quoteId={quote.quoteId}
                quoteLanguage={quote.customerLanguage}
                revision={quote.revisionNumber}
                status={quote.status}
              />
            </div>
            <div className="shrink-0 sm:text-right">
              <p className="text-[12px] text-ink-3">{q.total}</p>
              <p className="text-2xl font-semibold tabular-nums text-ink">
                {quote.state === "ready" ? money(quote.totalCents, language) : q.notPriced}
              </p>
            </div>
          </header>

          <ProgressLine nextLabel={r.next} stages={stages} />

          {canAct ? (
            <QuoteActions
              language={language}
              quoteId={quote.quoteId}
              ready={quote.state === "ready"}
              revision={quote.revisionNumber}
              status={quote.status}
            />
          ) : null}

          {quote.state === "needs_owner" && quote.reasons.length > 0 ? (
            <section className="rounded-card bg-orange-tint px-4 py-3 text-[13px]" role="status">
              <p className="font-medium text-orange">{q.stillNeeded}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink">
                {quote.reasons.map((reason) => (
                  <li key={reason}>{reasonText(reason, q)}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {sections.length >= 3 ? (
            <JumpBar end={caller.memberId !== null ? <QuoteViewToggle language={language} /> : undefined} label={r.sections} sections={sections} />
          ) : caller.memberId !== null ? (
            <div className="flex justify-end">
              <QuoteViewToggle language={language} />
            </div>
          ) : null}

          <RecordColumns
            main={
              <>
                <RecordSection id="lines">
                  <div className="space-y-6">
                    <Card
                      actions={
                        canEdit ? (
                          <EditQuoteButton
                            customerNotes={quote.customerNotes}
                            items={items}
                            language={language}
                            lines={quote.lines.map((line) => ({ itemId: line.itemId, name: line.name, unitLabel: line.unitLabel, quantity: line.quantity, unitCents: line.unitCents }))}
                            quoteId={quote.quoteId}
                            revision={quote.revisionNumber}
                            status={quote.status}
                          />
                        ) : null
                      }
                      flush
                      title={q.lines}
                    >
                      <Table
                        head={
                          <>
                            <Th>{q.item}</Th>
                            <Th className="text-right">{q.quantity}</Th>
                            <Th className="text-right">{q.unitPrice}</Th>
                            <Th className="text-right">{q.lineTotal}</Th>
                          </>
                        }
                      >
                        {quote.lines.map((line, index) => (
                          <tr key={`${line.name}-${index}`}>
                            <Td>
                              <span className="font-medium">
                                <QuoteText id={`line:${index}`} language={language} text={line.name} />
                              </span>
                              <span className="block text-[12px] text-ink-3">
                                {line.unitLabel?.trim() ? <QuoteText id={unitTextId(line.unitLabel)} language={language} text={line.unitLabel} /> : null}
                                {line.source === "override" ? <span className="text-orange"> · {q.setOnQuote}</span> : null}
                              </span>
                            </Td>
                            <Td className="text-right tabular-nums">{quantity(line.quantity)}</Td>
                            <Td className="text-right whitespace-nowrap tabular-nums">
                              {line.unitCents === null ? <span className="text-orange">{q.unpriced}</span> : money(line.unitCents, language)}
                            </Td>
                            <Td className="text-right whitespace-nowrap tabular-nums">{money(line.totalCents, language)}</Td>
                          </tr>
                        ))}
                      </Table>
                      <dl className="space-y-1.5 border-t border-line px-4 py-3 text-[13px]">
                        {quote.ruleLines.map((rule) => (
                          <div className="flex justify-between gap-4" key={rule.ruleId}>
                            <dt className="text-ink-2">
                              <QuoteText id={`rule:${rule.ruleId}`} language={language} text={rule.label} />
                            </dt>
                            <dd className="tabular-nums">{signed(rule.cents, language)}</dd>
                          </div>
                        ))}
                        {quote.minimumAppliedCents > 0 ? (
                          <div className="flex justify-between gap-4">
                            <dt className="text-ink-2">{q.minimum}</dt>
                            <dd className="tabular-nums">{signed(quote.minimumAppliedCents, language)}</dd>
                          </div>
                        ) : null}
                        {quote.adjustmentCents !== 0 ? (
                          <div className="flex justify-between gap-4">
                            <dt className="text-ink-2">{q.adjustment}</dt>
                            <dd className="tabular-nums">{signed(quote.adjustmentCents, language)}</dd>
                          </div>
                        ) : null}
                        {quote.taxCents > 0 ? (
                          <div className="flex justify-between gap-4">
                            <dt className="text-ink-2">{q.tax}</dt>
                            <dd className="tabular-nums">{signed(quote.taxCents, language)}</dd>
                          </div>
                        ) : null}
                        <div className="flex justify-between gap-4 pt-1 text-sm font-semibold">
                          <dt>{q.total}</dt>
                          <dd className="tabular-nums">{quote.state === "ready" ? money(quote.totalCents, language) : q.notPriced}</dd>
                        </div>
                      </dl>
                    </Card>
                    {quote.customerNotes?.trim() ? (
                      <Card title={q.customerNotes}>
                        <div className="text-[13px] text-ink text-pretty">
                          <QuoteText id="notes" language={language} note text={quote.customerNotes} />
                        </div>
                      </Card>
                    ) : null}
                  </div>
                </RecordSection>

                {quote.attachments.length > 0 ? (
                  <RecordSection id="photos">
                    <Card actions={canEdit ? <AddPhotosButton language={language} quoteId={quote.quoteId} /> : null} title={q.photos}>
                      {quote.attachments.length === 0 ? (
                        <p className="text-[13px] text-ink-3">{q.noPhotos}</p>
                      ) : (
                        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                          {quote.attachments.map((attachment, index) => {
                            const href = `/api/quotes/${quote.quoteId}/photos/${attachment.id}`;
                            const image = !attachment.name || IMAGE_NAME.test(attachment.name);
                            return (
                              <li className="relative" key={attachment.id}>
                                <a
                                  className="block aspect-square overflow-hidden rounded-[8px] bg-inset shadow-hairline transition-opacity hover:opacity-90"
                                  href={href}
                                  rel="noopener"
                                  target="_blank"
                                  title={attachment.description ?? attachment.name ?? undefined}
                                >
                                  {image ? (
                                    // eslint-disable-next-line @next/next/no-img-element -- served by our own route, any size
                                    <img alt={attachment.description ?? q.photoAlt(index + 1)} className="size-full object-cover" loading="lazy" src={href} />
                                  ) : (
                                    <span className="flex size-full flex-col items-center justify-center gap-1 p-2 text-center text-[11px] text-ink-2">
                                      <Paperclip aria-hidden="true" className="size-4" />
                                      <span className="line-clamp-2 break-all">{attachment.name}</span>
                                    </span>
                                  )}
                                </a>
                                {canEdit ? (
                                  <RemovePhotoButton language={language} photoId={attachment.id} quoteId={quote.quoteId} revision={quote.revisionNumber} status={quote.status} />
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </Card>
                  </RecordSection>
                ) : null}

                {hasPhoto || pricedPhoto ? (
                  <RecordSection id="priced-photo">
                    <Card
                      actions={caller.memberId !== null && hasPhoto ? <PricePhotoButton again={pricedPhoto !== null} language={language} quoteId={quote.quoteId} /> : null}
                      title={q.pricedPhoto}
                    >
                      {pricedOutcome && pricedOutcome !== "done" ? (
                        <p className="mb-2 text-[13px] text-destructive" role="alert">
                          {q.pricedOutcome[pricedOutcome] ?? q.pricedOutcome.failed}
                        </p>
                      ) : null}
                      {pricedPhoto ? (
                        <figure className="space-y-1.5">
                          <a className="block overflow-hidden rounded-[8px] bg-inset shadow-hairline transition-opacity hover:opacity-90" href={pricedPhoto.url} rel="noopener" target="_blank">
                            {/* eslint-disable-next-line @next/next/no-img-element -- served by our own route, any size */}
                            <img alt={q.pricedAlt} className="block h-auto w-full" src={pricedPhoto.url} />
                          </a>
                          <figcaption className="text-[12px] text-ink-3 text-pretty">
                            {q.pricedCaption}
                            {pricedPhoto.notLocated.length > 0 ? ` ${q.pricedNotLocated(pricedPhoto.notLocated.join(", "))}` : ""}
                          </figcaption>
                        </figure>
                      ) : (
                        <p className="text-[13px] text-ink-3">{q.pricedNone}</p>
                      )}
                    </Card>
                  </RecordSection>
                ) : null}

                {work.length > 0 || bookHref ? (
                  <RecordSection id="work">
                    <WorkCard bookHref={bookHref} jobs={work} language={language} timeZone={tz} />
                  </RecordSection>
                ) : null}

                {notes.length > 0 ? (
                  <RecordSection id="notes">
                    <Card
                      actions={caller.memberId !== null ? <NoteEditor language={language} quote={{ id: quote.quoteId, title: quote.title }} trigger="quiet" /> : null}
                      flush
                      title={copy.notes.onQuote}
                    >
                      <NoteList editable={(note) => canEditNote(caller, note)} language={language} notes={notes} showPlace={false} timeZone={tz} />
                    </Card>
                  </RecordSection>
                ) : null}

                {quote.attachments.length === 0 || notes.length === 0 ? (
                  <EmptyFold
                    actions={
                      caller.memberId !== null ? (
                        <>
                          {quote.attachments.length === 0 && canEdit ? <AddPhotosButton language={language} quoteId={quote.quoteId} /> : null}
                          {notes.length === 0 ? <NoteEditor language={language} quote={{ id: quote.quoteId, title: quote.title }} trigger="quiet" /> : null}
                        </>
                      ) : null
                    }
                  >
                    {quote.attachments.length === 0 && notes.length === 0
                      ? copy.record.empty.photosAndNotes
                      : quote.attachments.length === 0
                        ? copy.record.empty.photos
                        : copy.record.empty.notes}
                  </EmptyFold>
                ) : null}

                {jobs.length > 0 ? (
                  <RecordSection id="threads">
                    <Card flush title={copy.jobs.onRecord}>
                      <JobsTable jobs={jobs} language={language} showAbout={false} showMember={isPrivileged(caller.role)} timeZone={tz} />
                    </Card>
                  </RecordSection>
                ) : null}

                <RecordSection id="timeline">
                  <Card title={q.timeline}>
                    <ol className="space-y-3">
                      {timeline.map((entry, index) => (
                        <li className="flex gap-3 text-[13px]" key={`${entry.kind}-${index}`}>
                          <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-ink-3" />
                          <div className="min-w-0">
                            <p className="text-ink">{timelineText(entry, q, language)}</p>
                            <p className="text-[12px] text-ink-3">{formatDateTime(entry.at, language, tz)}</p>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </Card>
                </RecordSection>
              </>
            }
            rail={
              <>
                <RailFact label={q.customer}>
                  {quote.customer ? (
                    <div className="space-y-1">
                      <Link className="block font-medium text-accent-ink hover:underline" href={`/customers/${quote.customer.id}`}>
                        {quote.customer.name}
                      </Link>
                      {quote.customer.phones.map((phone) => (
                        <a className="block text-ink-2 tabular-nums hover:underline" href={`tel:${phone}`} key={phone}>
                          {formatPhone(phone)}
                        </a>
                      ))}
                      {quote.customer.emails.map((email) => (
                        <a className="block break-all text-ink-2 hover:underline" href={`mailto:${email}`} key={email}>
                          {email}
                        </a>
                      ))}
                      {quote.propertyAddress ? <p className="text-ink-2">{quote.propertyAddress}</p> : null}
                    </div>
                  ) : (
                    <span className="text-ink-3">{q.noCustomerYet}</span>
                  )}
                </RailFact>

                {billing.invoice || (billing.canCreate && canAct) ? (
                  <RailFact label={q.invoice}>
                    {billing.invoice ? (
                      <span className="flex items-center gap-2">
                        {billing.canOpen ? (
                          <Link className="font-medium text-accent-ink tabular-nums hover:underline" href={`/invoices/${billing.invoice.invoiceId}`}>
                            {billing.invoice.label}
                          </Link>
                        ) : (
                          <span className="font-medium tabular-nums">{billing.invoice.label}</span>
                        )}
                        <InvoiceStatusPill language={language} status={billing.invoice.status} />
                      </span>
                    ) : (
                      <CreateInvoiceButton about={{ quoteId: quote.quoteId }} language={language} />
                    )}
                  </RailFact>
                ) : null}

                {quote.customerLink ? (
                  <RailFact label={q.customerLink}>
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <CopyButton done={q.copied} label={q.copyLink} text={quote.customerLink} />
                        <a className="inline-flex items-center gap-1 font-medium text-accent-ink hover:underline" href={quote.customerLink} rel="noopener" target="_blank">
                          {q.openLink}
                          <ExternalLink aria-hidden="true" className="size-3.5" />
                        </a>
                      </div>
                      {quote.customerApproval ? <p className="text-ink-2">{q.approvedOnline(quote.customerApproval.name, formatDate(quote.customerApproval.at, language, tz))}</p> : null}
                      {quote.depositCents ? (
                        <p className="text-ink-2 tabular-nums">
                          {q.depositAsked(money(quote.depositCents, language))}
                          {depositPaidCents !== null ? ` · ${q.depositPaid(money(depositPaidCents, language))}` : ""}
                        </p>
                      ) : null}
                    </div>
                  </RailFact>
                ) : null}

                <RailFact label={q.pdf}>
                  {quote.pdfUrl ? (
                    <a className="inline-flex items-center gap-1.5 font-medium text-accent-ink hover:underline" href={`/api/quotes/${quote.quoteId}/pdf`} rel="noopener" target="_blank">
                      <FileText aria-hidden="true" className="size-3.5" />
                      {q.openPdf}
                    </a>
                  ) : (
                    <span className="text-ink-3 text-pretty">{quote.status === "void" ? q.noPdfVoid : q.noPdf}</span>
                  )}
                </RailFact>

                {quote.revisions.length > 1 ? (
                  <RailFact label={q.revisions}>
                    <ul className="space-y-1">
                      {quote.revisions.map((revision) => (
                        <li className="flex items-baseline justify-between gap-3" key={revision.number}>
                          <span className={revision.number === quote.revisionNumber ? "font-medium" : "text-ink-2"}>
                            {q.revision(revision.number)} · {formatDate(revision.createdAt, language, tz)}
                          </span>
                          <span className="text-ink-2 tabular-nums">{money(revision.totalCents, language)}</span>
                        </li>
                      ))}
                    </ul>
                  </RailFact>
                ) : null}
              </>
            }
          />
          </QuoteTranslationProvider>
        </PageBody>
      </PaperPage>
    </>
  );
}

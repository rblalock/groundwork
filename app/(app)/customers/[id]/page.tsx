import { notFound } from "next/navigation";
import {
  AddPropertyForm,
  ArchiveCustomerButton,
  ContactEditor,
  CustomerDetailsEditor,
  MergeCustomerButton,
  RemoveContactButton,
} from "@/components/pages/customer-editors";
import { NoteEditor } from "@/components/pages/note-editors";
import { NoteList } from "@/components/pages/note-list";
import { StatusPill } from "@/ui/beautiful/atoms/StatusPill";
import Link from "next/link";
import type { CustomerChange } from "@/core/customers";
import { Card, Crumb, LinkRow, Nothing, PageBody, QuoteStatusPill, Table, Td, Th, ViewingNotice } from "@/components/pages/kit";
import { RailFact, RecordColumns } from "@/components/record/layout";
import { RecordTabs } from "@/components/record/tabs";
import { wallClock, whenText } from "@/core/scheduling-time";
import { JobsTable } from "@/components/pages/jobs";
import { WorkCard } from "@/components/schedule/work-card";
import { PaperPage } from "@/components/paper";
import { OnScreen } from "@/components/threads/on-screen";
import { isLanguage } from "@/core/language";
import { isPrivileged } from "@/core/members";
import { getProfile } from "@/core/profile";
import { formatDate, formatDateTime, formatPhone, money } from "@/lib/format";
import { HttpError } from "@/lib/guards";
import { pageCopyFor, type PageCopy } from "@/lib/page-copy";
import { pageMember } from "@/lib/page-session";
import { customerFor, customerTabCounts } from "@/lib/pages/customers";
import { canEditNote, customerNotesFor } from "@/lib/pages/notes";
import { customerInvoicesFor } from "@/lib/pages/invoices";
import { InvoiceStatusPill } from "@/components/invoices/kit";
import { jobsOn } from "@/lib/pages/jobs";
import { workOn } from "@/lib/pages/schedule";
import { customerPriceGuide, customerWorkPhotos } from "@/lib/pages/work";
import { AskAssistantButton } from "@/components/threads/thread-rail";
import { copyFor } from "@/lib/copy";

const TABS = ["quotes", "work", "invoices", "photos", "notes", "threads", "history"] as const;
type Tab = (typeof TABS)[number];

export default async function CustomerDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const caller = await pageMember();
  const { id } = await params;
  const { tab: rawTab } = await searchParams;
  const page = await customerFor(caller, id).catch((error: unknown) => {
    if (error instanceof HttpError && error.status === 404) notFound();
    throw error;
  });
  const privileged = isPrivileged(caller.role);
  const shown: Tab[] = TABS.filter((t) => (t === "invoices" || t === "history" ? privileged : true));
  const tab: Tab = shown.find((t) => t === rawTab) ?? "quotes";
  // The rail's facts and the tabs' counts are read every time; a tab's records only when it's open.
  const [profile, work, billing, counts, photos, notes, jobs, priceGuide] = await Promise.all([
    getProfile(caller.orgId),
    workOn(caller, { customerId: page.customer.id }),
    customerInvoicesFor(caller, page.customer.id),
    customerTabCounts(caller, page.customer.id),
    customerWorkPhotos(caller, page.customer.id),
    tab === "notes" ? customerNotesFor(caller, page.customer.id) : null,
    tab === "threads" ? jobsOn(caller, { customerId: page.customer.id }) : null,
    tab === "photos" ? customerPriceGuide(caller, page.customer.id) : null,
  ]);
  const { customer, quotes, history, mergedInto } = page;
  const { language } = caller;
  const copy = pageCopyFor(language);
  const c = copy.customers;
  const tz = profile.timeZone;
  const archived = customer.archivedAt !== null;
  // Anyone on the team edits a customer; archiving and merging are the owner's and admins'.
  const canEdit = caller.memberId !== null && !archived;
  const canManage = caller.memberId !== null && privileged && !mergedInto;
  const canNote = caller.memberId !== null && !archived;
  const noteCustomer = { id: customer.id, name: customer.name, properties: customer.properties.map((p) => ({ id: p.id, address: p.address })) };
  const customerLanguage = isLanguage(customer.language) ? customer.language : "en";
  const visits = work.flatMap((job) => job.visits).filter((v) => v.status !== "cancelled");
  const nextVisit = visits
    .filter((v) => v.status !== "completed" && v.startAt.getTime() > Date.now())
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())[0];
  const tabCount: Record<Tab, number | undefined> = {
    quotes: quotes.length,
    work: work.length,
    invoices: billing?.invoices.length,
    photos: counts.photos,
    notes: counts.notes,
    threads: jobs?.length,
    history: history.length,
  };
  const href = (t: Tab) => (t === "quotes" ? `/customers/${customer.id}` : `/customers/${customer.id}?tab=${t}`);

  return (
    <>
      <OnScreen record={{ kind: "customer", id: customer.id, label: customer.name }} />
      <PaperPage
        actions={
          <div className="flex items-center gap-1">
            {!archived && !mergedInto ? <AskAssistantButton label={copyFor(language).rail.ask} start={{ customerId: customer.id, reuse: true }} /> : null}
            {canManage ? (
              <>
                {!archived ? <MergeCustomerButton customer={{ id: customer.id, name: customer.name, revision: customer.revision }} language={language} /> : null}
                <ArchiveCustomerButton customer={{ id: customer.id, name: customer.name, revision: customer.revision, archived }} language={language} />
              </>
            ) : null}
          </div>
        }
        title={<Crumb href="/customers" parent={c.back}>{customer.name}</Crumb>}
      >
        <PageBody>
          {caller.memberId === null ? <ViewingNotice language={language} /> : null}
          {mergedInto ? (
            <p className="rounded-[10px] bg-inset px-3 py-2 text-[13px] text-ink-2" role="note">
              {c.mergedNotice}{" "}
              <Link className="font-medium text-ink underline" href={`/customers/${mergedInto.id}`}>
                {mergedInto.name}
              </Link>
            </p>
          ) : archived && customer.archivedAt ? (
            <p className="rounded-[10px] bg-inset px-3 py-2 text-[13px] text-ink-2" role="note">
              {c.archivedNotice(formatDate(customer.archivedAt, language, tz))}
            </p>
          ) : null}

          <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <h2 className="text-lg font-semibold text-balance text-ink">{customer.name}</h2>
            {billing ? (
              <p className={`shrink-0 text-[13px] font-medium tabular-nums ${billing.overdueCents > 0 ? "text-red" : "text-ink-2"}`}>
                {billing.balanceCents === 0
                  ? c.paidUp
                  : billing.overdueCents > 0
                    ? c.owesOverdue(money(billing.balanceCents, language), money(billing.overdueCents, language))
                    : c.owes(money(billing.balanceCents, language))}
              </p>
            ) : null}
          </header>

          <RecordColumns
            main={
              <>
                <RecordTabs
                  active={tab}
                  label={customer.name}
                  tabs={shown.map((t) => ({ key: t, label: c.tabs[t], href: href(t), count: tabCount[t] }))}
                />

                {tab === "quotes" ? (
                  <Card flush>
                    {quotes.length === 0 ? (
                      <Nothing>{c.noQuotes}</Nothing>
                    ) : (
                      <Table
                        head={
                          <>
                            <Th>{copy.quotes.columns.quote}</Th>
                            <Th className="text-right">{copy.quotes.columns.total}</Th>
                            <Th>{copy.quotes.columns.status}</Th>
                            <Th className="hidden @xl:table-cell">{copy.quotes.columns.updated}</Th>
                          </>
                        }
                      >
                        {quotes.map((quote) => (
                          <LinkRow href={`/quotes/${quote.quoteId}`} key={quote.quoteId} label={<span className="block max-w-[28ch] truncate">{quote.title}</span>}>
                            <Td className="text-right whitespace-nowrap tabular-nums">
                              {quote.state === "ready" ? money(quote.totalCents, language) : <span className="text-ink-3">{copy.quotes.notPriced}</span>}
                            </Td>
                            <Td>
                              <QuoteStatusPill language={language} status={quote.status} />
                            </Td>
                            <Td className="hidden whitespace-nowrap text-ink-2 @xl:table-cell">{formatDate(quote.updatedAt, language, tz)}</Td>
                          </LinkRow>
                        ))}
                      </Table>
                    )}
                  </Card>
                ) : null}

                {tab === "work" ? (
                  work.length > 0 ? (
                    <WorkCard jobs={work} language={language} showTitle timeZone={tz} />
                  ) : (
                    <Card>
                      <p className="text-[13px] text-ink-3">{copy.schedule.noWork}</p>
                    </Card>
                  )
                ) : null}

                {tab === "invoices" && billing ? (
                  <Card flush>
                    {billing.invoices.length === 0 ? (
                      <Nothing>{c.noInvoices}</Nothing>
                    ) : (
                      <Table
                        head={
                          <>
                            <Th>{copy.invoices.columns.invoice}</Th>
                            <Th className="text-right">{copy.invoices.columns.total}</Th>
                            <Th className="text-right">{copy.invoices.columns.balance}</Th>
                            <Th>{copy.invoices.columns.status}</Th>
                          </>
                        }
                      >
                        {billing.invoices.map((invoice) => (
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
                            <Td className="text-right whitespace-nowrap tabular-nums">{money(invoice.totalCents, language)}</Td>
                            <Td className="text-right whitespace-nowrap tabular-nums">{invoice.status === "void" ? "—" : money(invoice.balanceCents, language)}</Td>
                            <Td>
                              <InvoiceStatusPill language={language} overdue={invoice.overdue} status={invoice.status} />
                            </Td>
                          </LinkRow>
                        ))}
                      </Table>
                    )}
                  </Card>
                ) : null}

                {tab === "photos" && priceGuide && priceGuide.length > 0 ? (
                  <Card title={c.priceGuide}>
                    <p className="mb-2.5 text-[13px] text-ink-3 text-pretty">{c.priceGuideHelp}</p>
                    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {priceGuide.map((photo) => (
                        <li className="min-w-0" key={photo.id}>
                          <Link className="block overflow-hidden rounded-[8px] bg-inset shadow-hairline transition-opacity hover:opacity-90" href={`/quotes/${photo.quoteId}`}>
                            {/* eslint-disable-next-line @next/next/no-img-element -- served by our own route, any size */}
                            <img alt={c.priceGuideAlt(photo.quoteTitle)} className="block h-auto w-full" loading="lazy" src={photo.href} />
                          </Link>
                          <p className="mt-1 flex gap-2 text-[12px]">
                            <span className="min-w-0 flex-1 truncate text-ink">{photo.quoteTitle}</span>
                            <span className="shrink-0 text-ink-3">{formatDate(photo.createdAt, language, tz)}</span>
                          </p>
                        </li>
                      ))}
                    </ul>
                  </Card>
                ) : null}

                {tab === "photos" ? (
                  <Card>
                    {photos.length === 0 ? (
                      <p className="text-[13px] text-ink-3">{copy.work.noPhotos}</p>
                    ) : (
                      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                        {photos.map((photo, index) => (
                          <li className="min-w-0" key={photo.id}>
                            <Link
                              className="block aspect-square overflow-hidden rounded-[8px] bg-inset shadow-hairline transition-opacity hover:opacity-90"
                              href={`/work/${photo.jobId}`}
                              title={copy.work.fromWork(photo.jobTitle)}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element -- served by our own route, any size */}
                              <img alt={photo.description ?? copy.work.photoAlt(index + 1)} className="size-full object-cover" loading="lazy" src={`/api/work/${photo.jobId}/photos/${photo.id}`} />
                            </Link>
                            <p className="mt-1 truncate text-[11px] text-ink-3">{photo.jobTitle}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                ) : null}

                {tab === "notes" && notes ? (
                  <Card actions={canNote ? <NoteEditor customer={noteCustomer} language={language} trigger="quiet" /> : null} flush title={c.siteNotes}>
                    {notes.length === 0 ? (
                      <Nothing>{c.noSiteNotes}</Nothing>
                    ) : (
                      <NoteList
                        customer={noteCustomer}
                        editable={(note) => !archived && canEditNote(caller, note)}
                        language={language}
                        notes={notes}
                        showPlace={false}
                        timeZone={tz}
                      />
                    )}
                  </Card>
                ) : null}

                {tab === "threads" && jobs ? (
                  <Card flush>
                    {jobs.length === 0 ? (
                      <Nothing>{copy.jobs.empty}</Nothing>
                    ) : (
                      <JobsTable jobs={jobs} language={language} showAbout={false} showMember={privileged} timeZone={tz} />
                    )}
                  </Card>
                ) : null}

                {tab === "history" && privileged ? (
                  <Card flush>
                    {history.length === 0 ? (
                      <Nothing>{c.noHistory}</Nothing>
                    ) : (
                      <ol className="divide-y divide-line">
                        {history.map((change) => (
                          <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 py-2.5 text-[13px]" key={change.id}>
                            <span className="min-w-0 text-ink">{describeChange(change, c)}</span>
                            <span className="text-[12px] whitespace-nowrap text-ink-3">
                              {change.memberName ?? c.system} · {formatDateTime(change.createdAt, language, tz)}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </Card>
                ) : null}
              </>
            }
            rail={
              <>
                <RailFact label={c.contacts}>
                  <div className="space-y-3">
                    {customer.contacts.length === 0 ? (
                      <p className="text-ink-3">{c.noContacts}</p>
                    ) : (
                      <ul className="space-y-3">
                        {customer.contacts.map((contact) => (
                          <li className="grid gap-0.5" key={contact.id}>
                            <div className="flex items-start gap-2">
                              <div className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-1.5 font-medium text-ink">
                                  {contact.name}
                                  {contact.preferred && customer.contacts.length > 1 ? <StatusPill tone="accent">{c.preferred}</StatusPill> : null}
                                </span>
                                {contact.role ? <span className="block text-[12px] text-ink-3">{contact.role}</span> : null}
                              </div>
                              {canEdit ? (
                                <div className="-mt-0.5 flex shrink-0">
                                  <ContactEditor contact={contact} customerId={customer.id} language={language} revision={customer.revision} />
                                  <RemoveContactButton contact={contact} customerId={customer.id} language={language} revision={customer.revision} />
                                </div>
                              ) : null}
                            </div>
                            {contact.phones.map((phone) => (
                              <a className="block tabular-nums text-ink-2 hover:underline" href={`tel:${phone}`} key={phone}>
                                {formatPhone(phone)}
                              </a>
                            ))}
                            {contact.emails.map((email) => (
                              <a className="block break-all text-ink-2 hover:underline" href={`mailto:${email}`} key={email}>
                                {email}
                              </a>
                            ))}
                          </li>
                        ))}
                      </ul>
                    )}
                    {canEdit ? <ContactEditor customerId={customer.id} language={language} revision={customer.revision} /> : null}
                  </div>
                </RailFact>

                <RailFact label={c.properties}>
                  <div className="space-y-2">
                    {customer.properties.length === 0 ? (
                      <p className="text-ink-3">{c.noProperties}</p>
                    ) : (
                      <ul className="space-y-2">
                        {customer.properties.map((property) => (
                          <li key={property.id}>
                            {property.address}
                            {property.notes ? <span className="block text-[12px] text-ink-3">{property.notes}</span> : null}
                          </li>
                        ))}
                      </ul>
                    )}
                    {canEdit ? <AddPropertyForm customerId={customer.id} language={language} revision={customer.revision} /> : null}
                  </div>
                </RailFact>

                {nextVisit ? (
                  <RailFact label={c.nextVisit}>
                    <Link
                      className="font-medium text-accent-ink hover:underline"
                      href={`/schedule?view=day&date=${wallClock(nextVisit.startAt, tz).date}&visit=${nextVisit.visitId}`}
                    >
                      {whenText(nextVisit.startAt, nextVisit.endAt, tz, language)}
                    </Link>
                  </RailFact>
                ) : null}

                {photos.length > 0 ? (
                  <RailFact label={c.latestPhotos}>
                    <ul className="flex gap-1.5">
                      {photos.slice(0, 4).map((photo, index) => (
                        <li className="min-w-0" key={photo.id}>
                          <Link className="block size-12 overflow-hidden rounded-[6px] bg-inset shadow-hairline hover:opacity-90" href={`/work/${photo.jobId}`} title={copy.work.fromWork(photo.jobTitle)}>
                            {/* eslint-disable-next-line @next/next/no-img-element -- served by our own route, any size */}
                            <img alt={photo.description ?? copy.work.photoAlt(index + 1)} className="size-full object-cover" loading="lazy" src={`/api/work/${photo.jobId}/photos/${photo.id}`} />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </RailFact>
                ) : null}

                <RailFact label={c.details}>
                  <div className="space-y-1">
                    <p>
                      <span className="text-ink-3">{c.language}: </span>
                      {copy.common.languages[customerLanguage]}
                    </p>
                    {customer.notes?.trim() ? <p className="whitespace-pre-line text-ink-2">{customer.notes}</p> : null}
                    {canEdit ? (
                      <CustomerDetailsEditor
                        customer={{ id: customer.id, name: customer.name, language: customerLanguage, notes: customer.notes, revision: customer.revision }}
                        language={language}
                      />
                    ) : null}
                  </div>
                </RailFact>
              </>
            }
          />
        </PageBody>
      </PaperPage>
    </>
  );
}

/** One line of a customer's history, in the reader's words. */
function describeChange(change: CustomerChange, c: PageCopy["customers"]): string {
  const name = (value: unknown) => (value && typeof value === "object" && "name" in value ? String((value as { name: unknown }).name) : "");
  const h = c.change;
  switch (change.kind) {
    case "customer.created":
      return h.created;
    case "customer.updated": {
      const before = change.before ?? {};
      const after = change.after ?? {};
      const fields = Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      return h.updated(fields.map((f) => h.fields[f] ?? f).join(", ") || h.fields.name);
    }
    case "contact.added":
      return h.contactAdded(name(change.after));
    case "contact.updated":
      return h.contactUpdated(name(change.after));
    case "contact.removed":
      return h.contactRemoved(name(change.before));
    case "contact.migrated":
      return h.contactMigrated(name(change.after));
    case "property.added":
      return h.propertyAdded(String(change.after?.address ?? ""));
    case "customer.archived":
      return h.archived;
    case "customer.restored":
      return h.restored;
    case "customer.merged":
      return h.merged(name(change.after?.from));
    case "customer.merged_into":
      return h.mergedInto(name(change.after?.into));
    default:
      return h.other;
  }
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { getProfile } from "@/core/profile";
import { InvoiceStatusPill } from "@/components/invoices/kit";
import { Card, Crumb, PageBody, ViewingNotice } from "@/components/pages/kit";
import { PaperPage } from "@/components/paper";
import { JumpBar, type JumpSection } from "@/components/record/jump-bar";
import { EmptyFold, RailFact, RecordColumns, RecordSection } from "@/components/record/layout";
import { ProgressLine } from "@/components/record/progress-line";
import { WorkCard } from "@/components/schedule/work-card";
import { ChecklistItems } from "@/components/work/checklist";
import { AddWorkPhotosButton, RemoveWorkPhotoButton } from "@/components/work/work-photos";
import { formatDate, formatDateTime } from "@/lib/format";
import { HttpError } from "@/lib/guards";
import { pageCopyFor } from "@/lib/page-copy";
import { pageMember } from "@/lib/page-session";
import { workFor } from "@/lib/pages/work";
import { shortWhen, workProgress } from "@/lib/record-progress";
import { StatusPill } from "@/ui/beautiful/atoms/StatusPill";

const TONES = { open: "accent", completed: "green", cancelled: "neutral" } as const;

/**
 * One piece of work: where it stands, its checklist, photos of it, and its visits, with who it's for, the
 * quote it came from, and its invoice in the rail. Everyone on the team sees it, ticks the checklist, and
 * adds photos.
 */
export default async function WorkPage({ params }: { params: Promise<{ id: string }> }) {
  const caller = await pageMember();
  const { id } = await params;
  const { job, quote, invoice, photos, canAddPhotos, checklist } = await workFor(caller, id).catch((error: unknown) => {
    if (error instanceof HttpError && error.status === 404) notFound();
    throw error;
  });
  const { language } = caller;
  const copy = pageCopyFor(language);
  const w = copy.work;
  const r = copy.record;
  const { timeZone } = await getProfile(caller.orgId);
  // A photo added here goes on the visit that happened last (or the only one), when there is one.
  const now = Date.now();
  const live = job.visits.filter((v) => v.status !== "cancelled");
  const happened = live.filter((v) => v.startAt.getTime() <= now).sort((a, b) => b.startAt.getTime() - a.startAt.getTime());
  const photoVisit = live.length === 1 ? live[0].visitId : (happened[0]?.visitId ?? null);
  const nextVisit = live
    .filter((v) => v.status !== "completed" && v.startAt.getTime() > now)
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())[0];
  const stages = workProgress(
    {
      status: job.status,
      hasVisits: live.length > 0,
      invoice: invoice?.status ?? null,
      bookedLabel: nextVisit ? r.workStages.bookedAt(shortWhen(nextVisit.startAt, language, timeZone)) : undefined,
    },
    r.workStages,
  );
  const sections: JumpSection[] = [
    ...(checklist ? [{ id: "checklist", label: w.checklist, count: checklist.total }] : []),
    ...(photos.length > 0 ? [{ id: "photos", label: w.photos, count: photos.length }] : []),
    { id: "visits", label: w.visits, count: live.length },
  ];

  return (
    <PaperPage title={<Crumb href="/schedule" parent={w.back}>{job.title}</Crumb>}>
      <PageBody>
        {caller.memberId === null ? <ViewingNotice language={language} /> : null}

        <header className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-ink">{job.title}</h2>
            <StatusPill className="whitespace-nowrap" dot tone={TONES[job.status]}>
              {w.status[job.status]}
            </StatusPill>
          </div>
          {job.address ? <p className="text-[13px] text-ink-2">{job.address}</p> : null}
        </header>

        <ProgressLine nextLabel={r.next} stages={stages} />

        {sections.length >= 3 ? <JumpBar label={r.sections} sections={sections} /> : null}

        <RecordColumns
          main={
            <>
              {checklist ? (
                <RecordSection id="checklist">
                  <Card
                    actions={<span className="text-[12px] whitespace-nowrap text-ink-3 tabular-nums">{w.checklistDone(checklist.done, checklist.total)}</span>}
                    description={w.checklistHelp}
                    title={w.checklist}
                  >
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                      <div className="min-w-0 flex-1">
                        <ChecklistItems
                          canTick={checklist.canTick}
                          jobId={job.id}
                          language={language}
                          rows={checklist.items.map((item) => ({
                            itemId: item.itemId,
                            text: item.text,
                            done: item.doneAt !== null,
                            tickedBy: item.doneAt && item.doneByName ? w.tickedBy(item.doneByName, formatDateTime(item.doneAt, language, timeZone)) : null,
                          }))}
                        />
                      </div>
                      {checklist.photoHref ? (
                        <a
                          className="block w-full shrink-0 overflow-hidden rounded-[8px] bg-inset shadow-hairline transition-opacity hover:opacity-90 sm:w-40"
                          href={checklist.photoHref}
                          rel="noopener"
                          target="_blank"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element -- served by our own route, any size */}
                          <img alt={w.pricedPhoto} className="w-full" loading="lazy" src={checklist.photoHref} />
                        </a>
                      ) : null}
                    </div>
                  </Card>
                </RecordSection>
              ) : null}

              {photos.length > 0 ? (
                <RecordSection id="photos">
                  <Card actions={canAddPhotos ? <AddWorkPhotosButton jobId={job.id} language={language} visitId={photoVisit} /> : null} title={w.photos}>
                    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {photos.map((photo, index) => {
                        const href = `/api/work/${job.id}/photos/${photo.id}`;
                        return (
                          <li className="relative min-w-0" key={photo.id}>
                            <a
                              className="block aspect-square overflow-hidden rounded-[8px] bg-inset shadow-hairline transition-opacity hover:opacity-90"
                              href={href}
                              rel="noopener"
                              target="_blank"
                              title={photo.description ?? undefined}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element -- served by our own route, any size */}
                              <img alt={photo.description ?? w.photoAlt(index + 1)} className="size-full object-cover" loading="lazy" src={href} />
                            </a>
                            <p className="mt-1 truncate text-[11px] text-ink-3">
                              {photo.description ? `${photo.description} · ` : ""}
                              {w.addedBy(photo.addedByName, formatDate(photo.createdAt, language, timeZone))}
                            </p>
                            {photo.canRemove ? <RemoveWorkPhotoButton jobId={job.id} label={w.takeOffPhoto(index + 1)} language={language} photoId={photo.id} /> : null}
                          </li>
                        );
                      })}
                    </ul>
                  </Card>
                </RecordSection>
              ) : (
                <EmptyFold actions={canAddPhotos ? <AddWorkPhotosButton jobId={job.id} language={language} visitId={photoVisit} /> : null}>
                  {r.empty.photos}
                </EmptyFold>
              )}

              <RecordSection id="visits">
                <WorkCard jobs={[job]} language={language} timeZone={timeZone} title={w.visits} />
              </RecordSection>
            </>
          }
          rail={
            job.customerId || quote || invoice ? (
              <>
                {job.customerId ? (
                  <RailFact label={w.customer}>
                    <div className="space-y-1">
                      <Link className="block font-medium text-accent-ink hover:underline" href={`/customers/${job.customerId}`}>
                        {job.customerName}
                      </Link>
                      {job.address ? <p className="text-ink-2">{job.address}</p> : null}
                    </div>
                  </RailFact>
                ) : null}
                {quote ? (
                  <RailFact label={w.quote}>
                    <Link className="font-medium text-accent-ink hover:underline" href={`/quotes/${quote.id}`}>
                      {quote.title}
                    </Link>
                  </RailFact>
                ) : null}
                {invoice ? (
                  <RailFact label={w.invoice}>
                    <span className="flex items-center gap-2">
                      {invoice.canOpen ? (
                        <Link className="font-medium text-accent-ink tabular-nums hover:underline" href={`/invoices/${invoice.invoiceId}`}>
                          {invoice.label}
                        </Link>
                      ) : (
                        <span className="font-medium tabular-nums">{invoice.label}</span>
                      )}
                      <InvoiceStatusPill language={language} status={invoice.status} />
                    </span>
                  </RailFact>
                ) : null}
              </>
            ) : null
          }
        />
      </PageBody>
    </PaperPage>
  );
}

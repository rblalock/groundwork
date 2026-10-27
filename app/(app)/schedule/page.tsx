import { CalendarDays } from "lucide-react";
import { PageBody, ViewingNotice } from "@/components/pages/kit";
import { EmptyState, PaperPage } from "@/components/paper";
import { ScheduleBoard } from "@/components/schedule/board";
import { isPrivileged } from "@/core/members";
import { getQuote } from "@/core/quotes";
import { getServiceJob } from "@/core/scheduling";
import { pageCopyFor } from "@/lib/page-copy";
import { pageMember } from "@/lib/page-session";
import { scheduleFor } from "@/lib/pages/schedule";

type Search = { view?: string; date?: string; visit?: string; book?: string };

/** The work a quote's page sent here to book (`?book=quote:<id>` or `job:<id>`), if the viewer may book it. */
async function bookTargetFor(orgId: string, book: string | undefined, canBook: boolean, viewer: Parameters<typeof getServiceJob>[0]) {
  if (!book || !canBook) return null;
  const [kind, id] = book.split(":");
  if (kind === "quote" && id) {
    const quote = await getQuote(orgId, id);
    return quote ? { key: book, label: quote.title } : null;
  }
  if (kind === "job" && id) {
    const job = await getServiceJob(viewer, id);
    return job && job.status === "open" ? { key: book, label: job.title } : null;
  }
  return null;
}

/**
 * The schedule: everyone's visits by day or week for owners and admins, who book and move them here;
 * a crew member's own day for crew. Everything here can also be done by asking the assistant.
 */
export default async function SchedulePage({ searchParams }: { searchParams: Promise<Search> }) {
  const caller = await pageMember();
  const search = await searchParams;
  const { language } = caller;
  const copy = pageCopyFor(language).schedule;
  const page = await scheduleFor(caller, { view: search.view, date: search.date });
  const bookTarget = await bookTargetFor(caller.orgId, search.book, isPrivileged(caller.role) && caller.memberId !== null, caller);
  return (
    <PaperPage title={copy.title}>
      <PageBody className="max-w-none">
        {caller.memberId === null ? <ViewingNotice language={language} /> : null}
        {page.crew.length === 0 ? (
          <EmptyState icon={<CalendarDays size={18} />}>{copy.noCrew}</EmptyState>
        ) : (
          <ScheduleBoard bookTarget={bookTarget} language={language} page={page} selectedId={search.visit ?? null} />
        )}
      </PageBody>
    </PaperPage>
  );
}

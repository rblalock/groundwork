import Link from "next/link";
import { CalendarPlus, ChevronRight } from "lucide-react";
import { Fragment } from "react";
import type { Language } from "@/core/language";
import type { ServiceJobView } from "@/core/scheduling";
import { wallClock, whenText } from "@/core/scheduling-time";
import { pageCopyFor } from "@/lib/page-copy";
import { StatusPill } from "@/ui/beautiful/atoms/StatusPill";
import { Card, Nothing } from "../pages/kit";

// The kit's small secondary button, as plain classes: its Button is a client component.
const BOOK_LINK =
  "inline-flex h-[27px] shrink-0 items-center gap-1.5 rounded-full bg-surface px-3 text-[13px] leading-none font-medium text-ink shadow-btn transition-colors hover:bg-inset";

const TONES = { proposed: "orange", scheduled: "accent", completed: "green", cancelled: "neutral" } as const;

/**
 * The work and visits on a quote's or a customer's page: each piece of work opening on its own page, each
 * visit on the Schedule page.
 * `bookHref` adds a button to book a visit, for owners and admins.
 */
export function WorkCard({
  jobs,
  language,
  timeZone,
  bookHref,
  showTitle = false,
  title,
}: {
  jobs: ServiceJobView[];
  language: Language;
  timeZone: string;
  bookHref?: string;
  showTitle?: boolean;
  /** In place of "Work and visits" (the work's own page says "Visits"). */
  title?: string;
}) {
  const copy = pageCopyFor(language);
  const s = copy.schedule;
  // Each piece of work leads to its own page (photos, its invoice), except on that page itself.
  const linkWork = title === undefined;
  return (
    <Card
      actions={
        bookHref ? (
          <Link className={BOOK_LINK} href={bookHref}>
            <CalendarPlus aria-hidden="true" className="size-3.5" />
            {s.bookThis}
          </Link>
        ) : undefined
      }
      flush
      title={title ?? s.onRecord}
    >
      {jobs.length === 0 || (!linkWork && jobs.every((job) => job.visits.length === 0)) ? (
        <Nothing>{s.noWork}</Nothing>
      ) : (
        <ul className="divide-y divide-line">
          {jobs.map((job) => (
            <Fragment key={job.id}>
              {linkWork ? (
                <li className="relative flex items-center gap-3 bg-inset/40 px-4 py-2 transition-colors hover:bg-hover">
                  <Link className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink-2 after:absolute after:inset-0" href={`/work/${job.id}`}>
                    {showTitle || jobs.length > 1 ? job.title : copy.work.open}
                  </Link>
                  <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
                </li>
              ) : null}
              {job.visits.map((visit) => (
                <li className="relative flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-hover" key={visit.visitId}>
                  <div className="min-w-0 flex-1">
                    <Link
                      className="block text-[13px] font-medium text-ink tabular-nums after:absolute after:inset-0"
                      href={`/schedule?view=day&date=${wallClock(visit.startAt, timeZone).date}&visit=${visit.visitId}`}
                    >
                      {whenText(visit.startAt, visit.endAt, timeZone, language)}
                    </Link>
                    <p className="truncate text-[12px] text-ink-3">{visit.crew.map((c) => c.name).join(", ")}</p>
                  </div>
                  <StatusPill className="shrink-0 whitespace-nowrap" dot tone={TONES[visit.status]}>
                    {s.status[visit.status]}
                  </StatusPill>
                </li>
              ))}
            </Fragment>
          ))}
        </ul>
      )}
    </Card>
  );
}

import Link from "next/link";
import type { JobListing, JobStatus } from "@/core/jobs";
import type { Language } from "@/core/language";
import { formatDate } from "@/lib/format";
import { pageCopyFor } from "@/lib/page-copy";
import { StatusPill } from "@/ui/beautiful/atoms/StatusPill";
import { LinkRow, Table, Td, Th } from "./kit";

// Jobs on the web: the member's list, and the jobs on a quote's or customer's page.

const TONES = { active: "accent", running: "orange", failed: "red", done: "green", archived: "neutral" } as const;

export function JobStatusPill({ status, language }: { status: JobStatus; language: Language }) {
  return (
    <StatusPill className="whitespace-nowrap" dot={status !== "archived"} tone={TONES[status]}>
      {pageCopyFor(language).jobs.status[status]}
    </StatusPill>
  );
}

/** What a job is about: links to its quote and customer, when it has them. */
export function JobAbout({ job, language }: { job: Pick<JobListing, "quoteId" | "quoteTitle" | "customerId" | "customerName">; language: Language }) {
  const copy = pageCopyFor(language).jobs;
  const links = [
    job.quoteId && job.quoteTitle ? (
      <Link className="relative z-10 hover:underline" href={`/quotes/${job.quoteId}`} key="quote">
        {copy.quote(job.quoteTitle)}
      </Link>
    ) : null,
    job.customerId && job.customerName ? (
      <Link className="relative z-10 hover:underline" href={`/customers/${job.customerId}`} key="customer">
        {copy.customer(job.customerName)}
      </Link>
    ) : null,
  ].filter(Boolean);
  if (links.length === 0) return <span className="text-ink-3">{copy.nothingLinked}</span>;
  return <span className="flex flex-col gap-0.5">{links}</span>;
}

/**
 * A table of jobs, each row opening the job. `showMember` adds who it belongs to, for an owner looking
 * at the jobs on a quote; `showAbout` the quote and customer it's about, for the member's own list.
 */
export function JobsTable({
  jobs,
  language,
  timeZone,
  showMember = false,
  showAbout = true,
}: {
  jobs: JobListing[];
  language: Language;
  timeZone: string;
  showMember?: boolean;
  showAbout?: boolean;
}) {
  const copy = pageCopyFor(language).jobs;
  return (
    <Table
      head={
        <>
          <Th>{copy.columns.job}</Th>
          {showMember ? <Th>{copy.columns.member}</Th> : null}
          {showAbout ? <Th className="hidden @xl:table-cell">{copy.columns.about}</Th> : null}
          <Th>{copy.columns.status}</Th>
          <Th className="hidden @xl:table-cell">{copy.columns.updated}</Th>
        </>
      }
    >
      {jobs.map((job) => (
        <LinkRow
          href={`/threads/${job.jobId}`}
          key={job.jobId}
          label={
            <span className="flex max-w-[32ch] items-center gap-2">
              {/* An email thread with news since its member last opened it. */}
              {job.unread ? <span aria-label={copy.unread} className="size-2 shrink-0 rounded-full bg-accent" role="img" /> : null}
              <span className={`truncate ${job.unread ? "font-semibold" : ""}`}>{job.title}</span>
            </span>
          }
        >
          {showMember ? <Td className="whitespace-nowrap text-ink-2">{job.memberName}</Td> : null}
          {showAbout ? (
            <Td className="hidden text-ink-2 @xl:table-cell">
              <JobAbout job={job} language={language} />
            </Td>
          ) : null}
          <Td>
            <JobStatusPill language={language} status={job.status} />
          </Td>
          <Td className="hidden whitespace-nowrap text-ink-2 @xl:table-cell">{formatDate(job.updatedAt, language, timeZone)}</Td>
        </LinkRow>
      ))}
    </Table>
  );
}

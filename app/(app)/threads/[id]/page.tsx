import { notFound } from "next/navigation";
import { Layers } from "lucide-react";
import { AssistantChat } from "@/components/assistant/assistant-chat";
import { Crumb } from "@/components/pages/kit";
import { JobActions } from "@/components/pages/job-actions";
import { JobAbout, JobStatusPill } from "@/components/pages/jobs";
import { EmptyState, Paper, PaperTitle } from "@/components/paper";
import { copyFor } from "@/lib/copy";
import { HttpError } from "@/lib/guards";
import { pageCopyFor } from "@/lib/page-copy";
import { pageMember } from "@/lib/page-session";
import { jobFor } from "@/lib/pages/jobs";
import { topicOfTitle } from "@/core/jobs";

/**
 * One thread, full screen (the panel beside other pages shows the same). Its member chats in it here (the
 * same eve session the assistant drives from their main conversation); an owner or admin may read a crew
 * member's thread about a quote or customer.
 */
export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const caller = await pageMember();
  const { id } = await params;
  const { job, listing, mine } = await jobFor(caller, id).catch((error: unknown) => {
    if (error instanceof HttpError && error.status === 404) notFound();
    throw error;
  });
  const { language } = caller;
  const copy = pageCopyFor(language).jobs;
  const chat = copyFor(language).job;
  const readOnlyNote = !mine ? chat.readOnly(listing.memberName) : job.status === "archived" ? chat.archived : undefined;
  const topic = topicOfTitle(job.title);
  const emptyBody = topic === "quote" ? chat.emptyQuote : topic === "customer" ? chat.emptyCustomer : topic === "pricebook" ? chat.emptyPricebook : topic === "billing" ? chat.emptyBilling : undefined;

  return (
    <Paper className="flex-1">
      <PaperTitle actions={mine ? <JobActions jobId={job.id} language={language} status={job.status} /> : null}>
        <span className="flex min-w-0 items-center gap-2">
          <Crumb href="/threads" parent={copy.back}>
            {listing.title}
          </Crumb>
          <JobStatusPill language={language} status={job.status} />
        </span>
      </PaperTitle>
      {listing.quoteId || listing.customerId ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2 text-[13px] text-ink-2">
          <JobAbout job={listing} language={language} />
        </div>
      ) : null}
      {job.eveSessionId ? (
        <AssistantChat conversationId={job.id} emptyBody={emptyBody} key={job.eveSessionId} language={language} readOnlyNote={readOnlyNote} sessionId={job.eveSessionId} variant="job" />
      ) : (
        <EmptyState icon={<Layers size={18} />}>{copy.noSession}</EmptyState>
      )}
    </Paper>
  );
}

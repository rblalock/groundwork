import { Layers, Mail } from "lucide-react";
import { Card, PageBody } from "@/components/pages/kit";
import { JobsTable } from "@/components/pages/jobs";
import { EmptyState, PaperPage } from "@/components/paper";
import { getProfile } from "@/core/profile";
import { copyFor } from "@/lib/copy";
import { pageCopyFor } from "@/lib/page-copy";
import { pageMember } from "@/lib/page-session";
import { myJobs } from "@/lib/pages/jobs";
import { AskAssistantButton } from "@/components/threads/thread-rail";

/**
 * The member's threads: conversations apart from their main one, started on the web, by the assistant,
 * or by an email they forwarded. `?source=email` lists only the email ones, unread first in mind.
 */
export default async function JobsPage({ searchParams }: { searchParams: Promise<{ source?: string }> }) {
  const caller = await pageMember();
  const { language } = caller;
  const copy = pageCopyFor(language).jobs;
  const email = (await searchParams).source === "email";
  const title = email ? copyFor(language).nav.email : copy.title;
  const icon = email ? <Mail size={18} /> : <Layers size={18} />;
  if (!caller.memberId) {
    return (
      <PaperPage title={title}>
        <EmptyState icon={icon}>{copyFor(language).assistant.viewing}</EmptyState>
      </PaperPage>
    );
  }
  const [jobs, profile] = await Promise.all([myJobs(caller, email ? { source: "email" } : {}), getProfile(caller.orgId)]);
  const actions = email ? undefined : <AskAssistantButton icon="new" label={copyFor(language).rail.newThread} start={{ topic: "new" }} variant="primary" />;
  return (
    <PaperPage actions={actions} title={title}>
      <PageBody>
        {jobs.length === 0 ? (
          <EmptyState icon={icon}>{email ? copy.emptyEmail : copy.empty}</EmptyState>
        ) : (
          <>
            <Card flush>
              <JobsTable jobs={jobs} language={language} timeZone={profile.timeZone} />
            </Card>
          </>
        )}
      </PageBody>
    </PaperPage>
  );
}

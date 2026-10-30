import { MessageSquareText } from "lucide-react";
import { headers } from "next/headers";
import { prettyLine } from "@/core/inbound";
import { assignedLineFor } from "@/core/members";
import { getProfile } from "@/core/profile";
import { AssistantChat } from "@/components/assistant/assistant-chat";
import { EmptyState, Paper, PaperPage, PaperTitle } from "@/components/paper";
import { copyFor } from "@/lib/copy";
import { textedFor, threadWithSession } from "@/lib/pages/assistant";
import { pageMember } from "@/lib/page-session";

const SAY_LIMIT = 500;

/**
 * Home: the member's thread with the assistant, their texts and web turns together. It's one eve
 * session, started by their first text or, for a member who hasn't texted yet, by their first visit
 * here. What the assistant texted them on its own (nudges, notices, PDFs) isn't in the session; it
 * shows between. `?say=` puts words in the text box, unsent: a "Quote it again" link's.
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ say?: string | string[] }> }) {
  const { say } = await searchParams;
  const caller = await pageMember();
  const copy = copyFor(caller.language);
  const icon = <MessageSquareText size={18} />;

  if (!caller.memberId) {
    return (
      <PaperPage title={copy.nav.assistant}>
        <EmptyState icon={icon}>{copy.assistant.viewing}</EmptyState>
      </PaperPage>
    );
  }

  const thread = await threadWithSession(caller, (await headers()).get("cookie") ?? "");
  // Only when the thread couldn't be started (the agent didn't answer): a text still starts it.
  if (!thread?.eveSessionId) {
    const line = await assignedLineFor(caller.orgId, caller.memberId);
    return (
      <PaperPage title={copy.nav.assistant}>
        <EmptyState icon={icon}>{copy.assistant.textFirst(line ? prettyLine(line) : null)}</EmptyState>
      </PaperPage>
    );
  }

  const [texted, profile] = await Promise.all([textedFor(caller), getProfile(caller.orgId)]);
  return (
    <Paper className="flex-1">
      <PaperTitle>{copy.nav.assistant}</PaperTitle>
      {/* Remounts if a new iMessage thread moves the member to another session. */}
      <AssistantChat
        conversationId={thread.id}
        draft={typeof say === "string" ? say.slice(0, SAY_LIMIT) : undefined}
        key={thread.eveSessionId}
        language={caller.language}
        sessionId={thread.eveSessionId}
        texted={texted}
        timeZone={profile.timeZone}
      />
    </Paper>
  );
}

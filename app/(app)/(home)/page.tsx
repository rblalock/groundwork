import { MessageSquareText } from "lucide-react";
import { threadFor } from "@/core/conversations";
import { prettyLine } from "@/core/inbound";
import { assignedLineFor } from "@/core/members";
import { getProfile } from "@/core/profile";
import { AssistantChat } from "@/components/assistant/assistant-chat";
import { EmptyState, Paper, PaperPage, PaperTitle } from "@/components/paper";
import { copyFor } from "@/lib/copy";
import { textedFor } from "@/lib/pages/assistant";
import { pageMember } from "@/lib/page-session";

/**
 * Home: the member's thread with the assistant, their texts and web turns together. It's the eve
 * session their first text started, so a member who hasn't texted yet is asked to text first. What the
 * assistant texted them on its own (nudges, notices, PDFs) isn't in the session; it shows between.
 */
export default async function Page() {
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

  const thread = await threadFor(caller.orgId, caller.memberId);
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
        key={thread.eveSessionId}
        language={caller.language}
        sessionId={thread.eveSessionId}
        texted={texted}
        timeZone={profile.timeZone}
      />
    </Paper>
  );
}

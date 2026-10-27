import { PageBody, ViewingNotice } from "@/components/pages/kit";
import { TeamManager } from "@/components/pages/team-manager";
import { PaperPage } from "@/components/paper";
import { pageCopyFor } from "@/lib/page-copy";
import { pagePrivileged } from "@/lib/page-session";
import { teamFor } from "@/lib/pages/team";

export default async function TeamPage() {
  const caller = await pagePrivileged();
  const team = await teamFor(caller);
  const { language } = caller;
  return (
    <PaperPage title={pageCopyFor(language).team.title}>
      <PageBody>
        {caller.memberId === null ? <ViewingNotice language={language} /> : null}
        <TeamManager
          canEdit={caller.memberId !== null}
          language={language}
          me={caller.memberId}
          myRole={caller.role}
          team={team.map(({ id, name, role, language, hasLogin, email, pendingEmail, phones }) => ({
            id,
            name,
            role,
            language,
            hasLogin,
            email,
            pendingEmail,
            phones: phones.map(({ e164, status, lastInboundAt }) => ({ e164, status, texted: lastInboundAt !== null })),
          }))}
        />
      </PageBody>
    </PaperPage>
  );
}

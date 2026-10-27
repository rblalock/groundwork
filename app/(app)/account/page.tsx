import { AccountEmailForm } from "@/components/pages/account-email-form";
import { AccountProfileForm } from "@/components/pages/account-profile-form";
import { PageBody, ViewingNotice } from "@/components/pages/kit";
import { PaperPage } from "@/components/paper";
import { pendingClaimOf } from "@/core/email-claims";
import { findMemberById } from "@/core/members";
import { pageCopyFor } from "@/lib/page-copy";
import { pageMember } from "@/lib/page-session";
import { emailForwardingFor } from "@/lib/pages/settings";

/** The signed-in member's own account: their name and language, and the address they forward emails to the assistant from. */
export default async function AccountPage() {
  const caller = await pageMember();
  const { language } = caller;
  const t = pageCopyFor(language).account;
  const [member, forwarding, claim] = await Promise.all([
    caller.memberId ? findMemberById(caller.orgId, caller.memberId) : null,
    emailForwardingFor(caller.orgId),
    caller.memberId ? pendingClaimOf(caller.orgId, caller.memberId) : null,
  ]);
  return (
    <PaperPage title={t.title}>
      <PageBody className="max-w-3xl">
        {caller.memberId === null ? <ViewingNotice language={language} /> : null}
        {member ? (
          <AccountProfileForm language={language} memberLanguage={member.language === "es" ? "es" : "en"} name={member.name} />
        ) : null}
        {member ? (
          <AccountEmailForm
            email={member.email}
            inboxAddress={forwarding.address}
            language={language}
            pending={claim ? { address: claim.address, expiresAt: claim.expiresAt.toISOString() } : null}
          />
        ) : (
          <p className="text-[13px] text-ink-2">{t.viewing}</p>
        )}
      </PageBody>
    </PaperPage>
  );
}

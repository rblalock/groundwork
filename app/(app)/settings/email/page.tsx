import { getProfile } from "@/core/profile";
import { DroppedEmailsCard } from "@/components/pages/dropped-emails-card";
import { EmailForwardingCard } from "@/components/pages/email-forwarding-card";
import { SettingsPage } from "@/components/pages/settings-tabs";
import { pagePrivileged } from "@/lib/page-session";
import { droppedEmailsFor, emailForwardingFor } from "@/lib/pages/settings";

/** Settings → Email: the business's address that members forward emails to, and the emails it dropped. */
export default async function EmailSettingsPage() {
  const caller = await pagePrivileged();
  const [forwarding, dropped, profile] = await Promise.all([emailForwardingFor(caller.orgId), droppedEmailsFor(caller), getProfile(caller.orgId)]);
  const { language } = caller;
  return (
    <SettingsPage language={language} viewing={caller.memberId === null}>
      <EmailForwardingCard forwarding={forwarding} language={language} />
      {forwarding.address ? <DroppedEmailsCard dropped={dropped} language={language} timeZone={profile.timeZone} /> : null}
    </SettingsPage>
  );
}

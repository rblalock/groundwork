import { SettingsForm } from "@/components/pages/settings-form";
import { SettingsPage } from "@/components/pages/settings-tabs";
import { pagePrivileged } from "@/lib/page-session";
import { settingsFor, settingsValues } from "@/lib/pages/settings";

/** Settings → General: what's printed on quotes, and the business's hours, language, and follow-ups. */
export default async function GeneralSettingsPage() {
  const caller = await pagePrivileged();
  const profile = await settingsFor(caller);
  const { language } = caller;
  return (
    <SettingsPage language={language} viewing={caller.memberId === null}>
      <SettingsForm canEdit={caller.memberId !== null} language={language} sections={["business", "schedule"]} values={settingsValues(profile)} />
    </SettingsPage>
  );
}

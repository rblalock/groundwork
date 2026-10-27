import { GlossaryCard } from "@/components/pages/glossary-card";
import { SettingsPage } from "@/components/pages/settings-tabs";
import { pagePrivileged } from "@/lib/page-session";
import { glossaryFor } from "@/lib/pages/settings";

/** Settings → Glossary: the business's own words, which translations and Spanish replies follow. */
export default async function GlossarySettingsPage() {
  const caller = await pagePrivileged();
  const glossary = await glossaryFor(caller);
  const { language } = caller;
  return (
    <SettingsPage language={language} viewing={caller.memberId === null}>
      <GlossaryCard canEdit={caller.memberId !== null} language={language} terms={glossary} />
    </SettingsPage>
  );
}

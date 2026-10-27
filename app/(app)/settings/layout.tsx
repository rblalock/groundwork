import type { ReactNode } from "react";
import { PageBody } from "@/components/pages/kit";
import { SettingsTabs } from "@/components/pages/settings-tabs";
import { PaperPage } from "@/components/paper";
import { pagePrivileged } from "@/lib/page-session";
import { pageCopyFor } from "@/lib/page-copy";

/** Settings' title and tabs, kept while moving between its sections; each section loads under them. */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const { language } = await pagePrivileged();
  // One width for every tab, so the tabs stay put moving between them.
  return (
    <PaperPage title={pageCopyFor(language).settings.title}>
      <PageBody className="max-w-3xl">
        <SettingsTabs language={language} />
        {children}
      </PageBody>
    </PaperPage>
  );
}

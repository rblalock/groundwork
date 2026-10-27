import { HourMeters, UsageReport } from "@/components/pages/usage-report";
import { SettingsPage } from "@/components/pages/settings-tabs";
import { isMonth } from "@/core/usage-report";
import { pagePrivileged } from "@/lib/page-session";
import { usageFor } from "@/lib/pages/usage";

/** Settings → Usage: what the assistant used this month, and the last hour against the limits. Owners and admins. */
export default async function UsagePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const caller = await pagePrivileged();
  const { month } = await searchParams;
  const { usage, hour } = await usageFor(caller, isMonth(month) ? month : null);
  const { language } = caller;
  return (
    <SettingsPage language={language} viewing={caller.memberId === null}>
      <HourMeters language={language} limits={hour.limits} window={hour.window} />
      <UsageReport language={language} monthHref={(m) => `/settings/usage?month=${m}`} usage={usage} />
    </SettingsPage>
  );
}

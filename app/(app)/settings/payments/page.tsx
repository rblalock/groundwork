import { SettingsForm } from "@/components/pages/settings-form";
import { SettingsPage } from "@/components/pages/settings-tabs";
import { StripeCard } from "@/components/pages/stripe-card";
import { pagePrivileged } from "@/lib/page-session";
import { settingsFor, settingsValues } from "@/lib/pages/settings";
import { stripeSettings } from "@/lib/stripe";

/** Settings → Payments: invoice terms, the deposit, the minimum and tax, whether customers see line prices, and card payments through Stripe (the owner's). */
export default async function PaymentsSettingsPage() {
  const caller = await pagePrivileged();
  const [profile, stripe] = await Promise.all([settingsFor(caller), stripeSettings(caller.orgId)]);
  const { language } = caller;
  const canEdit = caller.memberId !== null;
  // Admins change the rest; the deposit and Stripe are the owner's.
  const isOwner = canEdit && caller.role === "owner";
  return (
    <SettingsPage language={language} viewing={!canEdit}>
      <SettingsForm
        canEdit={canEdit}
        canEditOwnerFields={isOwner}
        language={language}
        sections={["invoicing", "pricing"]}
        values={settingsValues(profile)}
      />
      <StripeCard canEdit={isOwner} language={language} ownerOnly={canEdit && !isOwner} settings={stripe} />
    </SettingsPage>
  );
}

import { BrandingCard } from "@/components/pages/branding-card";
import { CustomerPagesCard } from "@/components/pages/customer-pages-card";
import { customerPagesFor } from "@/lib/pages/customer-pages";
import { SettingsPage } from "@/components/pages/settings-tabs";
import { isLanguage } from "@/core/language";
import { logoVersion } from "@/core/branding";
import { pagePrivileged } from "@/lib/page-session";
import { brandingSettingsFor } from "@/lib/pages/branding";
import { settingsFor } from "@/lib/pages/settings";

/** Settings → Branding: the logo, accent color, closing notes, which facts print on PDFs, and the customer pages. */
export default async function BrandingSettingsPage() {
  const caller = await pagePrivileged();
  const [profile, branding, pages] = await Promise.all([settingsFor(caller), brandingSettingsFor(caller), customerPagesFor(caller)]);
  const { language } = caller;
  return (
    <SettingsPage language={language} viewing={caller.memberId === null}>
      <BrandingCard
        canEdit={caller.memberId !== null}
        facts={{
          address: Boolean(profile.address),
          phone: Boolean(profile.phone),
          email: Boolean(profile.email),
          licenseNumber: Boolean(profile.licenseNumber),
        }}
        language={language}
        pdfLanguage={isLanguage(profile.language) ? profile.language : "en"}
        values={{
          logoVersion: logoVersion(branding.logoUrl),
          accentColor: branding.accentColor,
          quoteFooter: branding.quoteFooter,
          invoiceFooter: branding.invoiceFooter,
          showOnPdf: branding.showOnPdf,
        }}
      />
      <CustomerPagesCard canEdit={caller.memberId !== null} language={language} states={pages} />
    </SettingsPage>
  );
}

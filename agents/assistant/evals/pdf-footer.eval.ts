import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { getBranding } from "../../../core/branding";
import { getProfile } from "../../../core/profile";
import type config from "./evals.config";

// The owner sets how invoices end and what the PDF header shows, by text. Their words go on the PDF as
// they said them; nothing else about the business changes.
const TERMS = "Checks payable to Example Services Co. Thank you for your business!";

export default defineEval<typeof config>({
  description: "An owner's closing note for invoices, and leaving the phone off the PDFs, are saved by text as said.",
  async test(t) {
    const business = await t.context.seed.priced();
    const before = await getProfile(business.orgId);

    const turn = await t.send(`put "${TERMS}" at the bottom of our invoices, and leave our phone number off the PDFs`);
    t.succeeded();
    turn.calledTool("update_branding");
    turn.notCalledTool("update_profile");
    turn.notCalledTool("create_invoice");

    const branding = await getBranding(business.orgId);
    t.check(branding.invoiceFooter, equals(TERMS)).label("invoice closing note, word for word");
    t.check(branding.quoteFooter, equals(null)).label("quotes keep the standard line");
    t.check(branding.showOnPdf, satisfies((show: Record<string, boolean>) => !show.phone && show.address && show.email && show.licenseNumber, "only the phone is left off")).label("header facts");
    const after = await getProfile(business.orgId);
    t.check([after.name, after.phone, after.minimumChargeCents], equals([before.name, before.phone, before.minimumChargeCents])).label("business facts unchanged");
    t.judge(
      "The reply confirms in a line or two that invoices will end with their note and that the phone number is left off the PDFs. " +
        "It doesn't claim to have changed anything else. No markdown.",
    ).gate(0.7);
  },
});

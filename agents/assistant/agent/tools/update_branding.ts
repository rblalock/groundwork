import { defineTool } from "eve/tools";
import { updateBranding } from "../../../../core/branding";
import { brandingPatchSchema } from "../../../../core/pdf-style";
import { privilegedOnly } from "../../../../core/policies";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Change how the business's quote and invoice PDFs look, as the owner or an admin says: the accent color (a hex like #1f6feb; for a named color use its usual hex and say which), the closing note at the end of quotes or of invoices (terms, a thank-you, in their words), and which saved business facts print in the header (address, phone, email, license number). Pass only what they said; null goes back to the standard look. The logo is set_logo. It takes effect on the next PDF.",
  inputSchema: brandingPatchSchema,
  approval: privilegedOnly("change how the PDFs look"),
  async execute(patch, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const { branding, changed } = await updateBranding(caller, patch);
      return plain({
        changed,
        branding: {
          hasLogo: branding.logoUrl !== null,
          accentColor: branding.accentColor,
          quoteFooter: branding.quoteFooter,
          invoiceFooter: branding.invoiceFooter,
          showOnPdf: branding.showOnPdf,
        },
      });
    } catch (error) {
      return toolError(error);
    }
  },
});

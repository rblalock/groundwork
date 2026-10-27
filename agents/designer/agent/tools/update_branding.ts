import { defineTool } from "eve/tools";
import { updateBranding } from "../../../../core/branding";
import { brandingPatchSchema } from "../../../../core/pdf-style";
import { privilegedOnly } from "../../../../core/policies";
import { plain, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Change how the business's quote and invoice PDFs look, the files customers download from these pages, when the member says to (\"make the PDFs match\"): the accent color (a hex; the PDFs darken it as needed to stay readable on paper), the closing note at the end of quotes or of invoices (in their words), and which saved business facts print in the header (address, phone, email, license number). Unlike a design, it isn't a draft: the next PDF uses it. Pass only what they asked for; null goes back to the standard look.",
  inputSchema: brandingPatchSchema,
  approval: privilegedOnly("change how the PDFs look"),
  async execute(patch, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const { branding, changed } = await updateBranding(caller, patch);
      return plain({
        changed,
        pdf: {
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

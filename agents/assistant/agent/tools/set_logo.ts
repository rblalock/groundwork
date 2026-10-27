import { defineTool } from "eve/tools";
import { z } from "zod";
import { removeLogo, setLogoFromText } from "../../../../core/branding";
import { privilegedOnly } from "../../../../core/policies";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Set the business's logo from the photo or image file the member just texted, when they say to use it as the logo (\"use this as our logo\"). It's printed at the top of every quote and invoice PDF and shown in the web app and on the pay page. PNG and JPEG work, and iPhone photos too. remove true takes the logo off. Only the owner or an admin.",
  inputSchema: z.object({
    remove: z.boolean().optional().describe("true takes the logo off instead."),
  }),
  approval: privilegedOnly("change the business's logo"),
  async execute(input, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      if (input.remove) return plain(await removeLogo(caller));
      const logo = await setLogoFromText(caller);
      return plain({ logoSet: true, width: logo.width, height: logo.height });
    } catch (error) {
      return toolError(error);
    }
  },
});

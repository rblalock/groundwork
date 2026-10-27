import { defineTool } from "eve/tools";
import { z } from "zod";
import { removeLogo, setLogo } from "../../../../core/branding";
import { privilegedOnly } from "../../../../core/policies";
import { plain, requireCaller, toolError } from "../../../../core/tool-context";
import { lastAttachedImage } from "../lib/attached-image";

export default defineTool({
  description:
    "Make the image the member attached in this conversation the business's logo, when they say to use it as the logo (\"use this logo\", \"put this in the top left\"). It's the one logo: it fills {{business.logo}} on both customer pages and prints at the top of every quote and invoice PDF, right away, published or not. PNG and JPEG work, iPhone photos too. remove true takes the logo off. Only the owner or an admin.",
  inputSchema: z.object({
    remove: z.boolean().optional().describe("true takes the logo off instead."),
  }),
  approval: privilegedOnly("change the business's logo"),
  async execute(input, ctx) {
    try {
      const caller = await requireCaller(ctx);
      if (input.remove) return plain(await removeLogo(caller));
      const image = lastAttachedImage(ctx.messages);
      if (!image) throw new Error("NO_ATTACHED_IMAGE");
      const logo = await setLogo(caller, image);
      return plain({ logoSet: true, width: logo.width, height: logo.height });
    } catch (error) {
      return toolError(error);
    }
  },
});

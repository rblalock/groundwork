import { defineTool } from "eve/tools";
import { z } from "zod";
import { CUSTOMER_PAGE_KINDS } from "../../../../core/customer-page-template";
import { customerPageState, saveVersion } from "../../../../core/customer-pages";
import { privilegedOnly } from "../../../../core/policies";
import { requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Write a customer page's whole template: its first design, or a redesign. One complete HTML document with CSS and the page's slots, no scripts. It's checked, then saved as a new draft version: customers keep seeing what they saw until it's published. A rejected page comes back with its problems; fix them and write it again. For a smaller change, use edit_customer_page.",
  inputSchema: z.object({
    page: z.enum(CUSTOMER_PAGE_KINDS),
    request: z.string().trim().min(1).max(500).describe("What they asked for, in their words."),
    html: z.string().min(1).describe("The complete HTML document."),
  }),
  approval: privilegedOnly("design the business's customer pages"),
  async execute({ page, request, html }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const saved = await saveVersion(caller, page, html, request);
      const state = await customerPageState(caller.orgId, page);
      return { page, version: saved.version, liveVersion: state.published?.version ?? null };
    } catch (error) {
      return toolError(error);
    }
  },
});

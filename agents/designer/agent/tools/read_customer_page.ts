import { defineTool } from "eve/tools";
import { z } from "zod";
import { CUSTOMER_PAGE_KINDS } from "../../../../core/customer-page-template";
import { pageForDesign } from "../../../../core/customer-pages";
import { privilegedOnly } from "../../../../core/policies";
import { requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Read the business's own design of a customer page before changing it: the quote's link (page \"quote\") or the invoice's pay link (page \"invoice\"). Returns its newest template (null before the first design; edit_customer_page replaces text in exactly this), which version customers see, the other page's template to match, the page's slots, how our blocks are marked up, and the business's facts.",
  inputSchema: z.object({ page: z.enum(CUSTOMER_PAGE_KINDS) }),
  approval: privilegedOnly("design the business's customer pages"),
  async execute({ page }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      return await pageForDesign(caller.orgId, page);
    } catch (error) {
      return toolError(error);
    }
  },
});

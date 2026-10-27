import { defineTool } from "eve/tools";
import { z } from "zod";
import { CUSTOMER_PAGE_KINDS } from "../../../../core/customer-page-template";
import { publishVersion, useStandardPage } from "../../../../core/customer-pages";
import { privilegedOnly } from "../../../../core/policies";
import { requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Make a design of the quote or invoice customer page the one customers see, once the owner or an admin says so (\"publish it\", \"looks good, go live\"): the newest version, or the version they name. useStandard: true goes back to the app's standard page instead (the designs stay). Reply in one line with what customers see now.",
  inputSchema: z.object({
    page: z.enum(CUSTOMER_PAGE_KINDS),
    version: z.number().int().positive().optional(),
    useStandard: z.boolean().default(false),
  }),
  approval: privilegedOnly("change the business's customer pages"),
  async execute({ page, version, useStandard }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const state = useStandard ? await useStandardPage(caller, page) : await publishVersion(caller, page, version);
      return { page, live: state.published?.version ?? null, customersSee: state.published ? `version ${state.published.version}` : "the standard page" };
    } catch (error) {
      return toolError(error);
    }
  },
});

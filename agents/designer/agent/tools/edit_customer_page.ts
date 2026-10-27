import { defineTool } from "eve/tools";
import { z } from "zod";
import { CUSTOMER_PAGE_KINDS } from "../../../../core/customer-page-template";
import { customerPageState, editVersion } from "../../../../core/customer-pages";
import { privilegedOnly } from "../../../../core/policies";
import { requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Change a customer page's design with exact replacements in its newest template: \"make the button green\", \"move the total up\". Every change the request needs goes in one call; they apply in order, and each old_string must appear exactly once in the template as read_customer_page returned it (after the edits before it). The result is checked and saved as a new draft version.",
  inputSchema: z.object({
    page: z.enum(CUSTOMER_PAGE_KINDS),
    request: z.string().trim().min(1).max(500).describe("What they asked for, in their words."),
    edits: z
      .array(z.object({ old_string: z.string().min(1), new_string: z.string() }))
      .min(1)
      .max(20),
  }),
  approval: privilegedOnly("design the business's customer pages"),
  async execute({ page, request, edits }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const saved = await editVersion(caller, page, edits, request);
      const state = await customerPageState(caller.orgId, page);
      return { page, version: saved.version, liveVersion: state.published?.version ?? null };
    } catch (error) {
      return toolError(error);
    }
  },
});

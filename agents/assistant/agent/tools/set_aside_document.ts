import { defineTool } from "eve/tools";
import { z } from "zod";
import { setAsideRecentAttachments } from "../../../../core/quotes";
import { plain, requireCaller, toolError } from "../../../../core/tool-context";

// The same half hour create_quote and revise_quote look back for photos.
const PHOTO_WINDOW_MS = 30 * 60 * 1000;

export default defineTool({
  description:
    "Call once, before anything else, when the photos or files the member just sent are a document rather than photos of a job: a price list, rate card, old invoice, flyer, or customer list. It keeps them off quotes, so they never attach to a quote or print on a customer's PDF. Don't call it for job photos.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const setAside = await setAsideRecentAttachments(caller.orgId, caller.memberId, { windowMs: PHOTO_WINDOW_MS });
      return plain({ setAside });
    } catch (error) {
      return toolError(error);
    }
  },
});

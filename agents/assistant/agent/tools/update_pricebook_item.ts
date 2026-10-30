import { defineTool } from "eve/tools";
import { z } from "zod";
import { privilegedOnly } from "../../../../core/policies";
import { updateItem } from "../../../../core/pricebook";
import { cents, equipmentSchema, unitKindSchema } from "../../../../core/tool-schemas";
import { latestInbound, plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Change one saved pricebook item: reprice, rename, change its unit, mark it taxable or not, set what the work needs (equipment: \"mulch jobs need the trailer\"), or retire it (status retired). equipment is the whole list and replaces it: read_business shows what's saved, and [] clears it. Existing quotes keep the price they were made with. Prices are integer cents.",
  inputSchema: z.object({
    itemId: z.string(),
    priceCents: cents.optional(),
    name: z.string().min(1).optional(),
    unitLabel: z.string().min(1).optional(),
    unitKind: unitKindSchema.optional(),
    taxable: z.boolean().optional(),
    status: z.enum(["active", "retired"]).optional(),
    equipment: equipmentSchema.optional(),
  }),
  approval: privilegedOnly("change prices"),
  async execute({ itemId, ...patch }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const source = await latestInbound(caller.orgId, caller.memberId);
      return plain({ item: await updateItem(caller.orgId, itemId, patch, caller.memberId, source?.id) });
    } catch (error) {
      return toolError(error);
    }
  },
});

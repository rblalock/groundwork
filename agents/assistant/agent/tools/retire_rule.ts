import { defineTool } from "eve/tools";
import { z } from "zod";
import { privilegedOnly } from "../../../../core/policies";
import { retireRule } from "../../../../core/pricebook";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Retire a rule so new quotes stop using it, or drop a crew suggestion the owner turned down. Existing quotes keep it.",
  inputSchema: z.object({ ruleId: z.string() }),
  approval: privilegedOnly("change rules"),
  async execute({ ruleId }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const rule = await retireRule(caller.orgId, ruleId, caller.memberId);
      return plain({ rule: { id: rule.id, text: rule.text, kind: rule.kind, status: rule.status } });
    } catch (error) {
      return toolError(error);
    }
  },
});

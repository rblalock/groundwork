import { defineTool } from "eve/tools";
import { z } from "zod";
import { isPrivileged } from "../../../../core/members";
import { notifyOwners } from "../../../../core/outbound";
import { saveRule } from "../../../../core/pricebook";
import { ruleEffectSchema, ruleKindSchema } from "../../../../core/tool-schemas";
import { latestInbound, plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export default defineTool({
  description:
    "Save a rule a member just stated, in their words: a pricing modifier (\"add $50 for rush jobs\"), a scope note, an exclusion, or a process rule. From the owner or an admin it applies starting now. From crew it is saved as a suggestion and the owners are asked about it: ownersNotified have it now, ownersQueued get it when quiet hours end. status tells you which happened. Saved rules never change existing quotes.",
  inputSchema: z.object({
    text: z.string().min(1).describe("The rule as stated, lightly tidied."),
    kind: ruleKindSchema,
    effect: ruleEffectSchema.nullable().optional(),
  }),
  async execute({ text, kind, effect }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const source = await latestInbound(caller.orgId, caller.memberId);
      const privileged = isPrivileged(caller.role);
      const rule = await saveRule(
        caller.orgId,
        { text, kind, effect: effect ?? null, status: privileged ? "active" : "suggested" },
        caller.memberId,
        source?.id,
      );
      let owners: { notified: string[]; queued: string[] } = { notified: [], queued: [] };
      if (!privileged) {
        owners = await notifyOwners(caller.orgId, (owner) =>
          owner.language === "es"
            ? `${caller.name} sugirió una regla: "${oneLine(text)}". ¿La convierto en regla? Di "agrega la regla" o ignóralo.`
            : `${caller.name} suggested a rule: "${oneLine(text)}". Want me to make it a rule? Say "add the rule" or ignore it.`,
        );
      }
      return plain({
        rule: { id: rule.id, text: rule.text, kind: rule.kind, effect: rule.effect, status: rule.status },
        status: rule.status,
        ...(privileged ? {} : { ownersNotified: owners.notified, ownersQueued: owners.queued }),
      });
    } catch (error) {
      return toolError(error);
    }
  },
});

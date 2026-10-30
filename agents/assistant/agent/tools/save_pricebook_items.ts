import { defineTool } from "eve/tools";
import { z } from "zod";
import { privilegedOnly } from "../../../../core/policies";
import { saveItemsWithOutcome } from "../../../../core/pricebook";
import { cents, equipmentSchema, unitKindSchema } from "../../../../core/tool-schemas";
import { latestInbound, plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Save prices the owner or an admin just stated or confirmed, the moment they do: one call for all of them, up to 200, such as a whole price list. Each item is matched by name: a known name updates its price, a new name is added. Names and units are the member's own words, lightly tidied. Prices are integer cents ($12 → 1200). The minimum charge is not an item: save it with update_profile. equipment is what doing the work needs, in the owner's words (\"mulch jobs need the trailer\"), only when they said it; it replaces the item's list. Returns how many were added, updated, and already saved as is.",
  inputSchema: z.object({
    items: z
      .array(
        z.object({
          name: z.string().min(1).describe("The member's words for the work."),
          unitKind: unitKindSchema,
          unitLabel: z.string().min(1).describe("The unit in the member's words, singular, like 'widget' or 'hour'."),
          priceCents: cents,
          taxable: z.boolean().optional().describe("Only when the owner said this item is not taxed."),
          group: z.string().optional(),
          notes: z.string().optional(),
          equipment: equipmentSchema.optional().describe('What the work needs, like "trailer" or "chipper".'),
          createdFromQuoteId: z.string().optional().describe("The quote that prompted this price, if any."),
        }),
      )
      .min(1)
      .max(200),
  }),
  approval: privilegedOnly("change prices"),
  async execute({ items }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const source = await latestInbound(caller.orgId, caller.memberId);
      const saved = await saveItemsWithOutcome(caller.orgId, items, caller.memberId, source?.id);
      const count = (outcome: string) => saved.filter((s) => s.outcome === outcome).length;
      return plain({
        added: count("added"),
        updated: count("updated"),
        unchanged: count("unchanged"),
        items: saved.map(({ item: i }) => ({
          id: i.id,
          name: i.name,
          unitKind: i.unitKind,
          unitLabel: i.unitLabel,
          priceCents: i.priceCents,
          taxable: i.taxable,
          ...(i.equipment.length ? { equipment: i.equipment } : {}),
        })),
      });
    } catch (error) {
      return toolError(error);
    }
  },
});

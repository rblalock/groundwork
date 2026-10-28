import { defineTool } from "eve/tools";
import { privilegedOnly } from "../../../../core/policies";
import { assertMayPatchProfile, updateProfile } from "../../../../core/profile";
import { profilePatchSchema } from "../../../../core/tool-schemas";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Save business facts the owner or an admin states: the name, phone, email, or address printed on quotes, license number, time zone, quiet hours, how many days quotes are good for, follow-up days, the minimum charge per visit, the sales tax rate, invoice payment terms (\"net 15\" is 15, \"due on receipt\" is 0), or the deposit customers pay when they approve a quote on its link (\"25% down\" is 25, \"no deposit\" is 0; only the owner sets it), or whether customers see each line's price (\"hide line prices from customers\" is false: they see each line's quantity and the total). Pass only what they said. null clears a fact. Money is integer cents; tax is basis points (7% → 700).",
  inputSchema: profilePatchSchema,
  approval: privilegedOnly("change the business details"),
  async execute(patch, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      assertMayPatchProfile(caller.role, patch);
      const profile = await updateProfile(caller.orgId, patch, caller.memberId);
      return plain({
        profile: {
          name: profile.name,
          phone: profile.phone,
          email: profile.email,
          address: profile.address,
          licenseNumber: profile.licenseNumber,
          timeZone: profile.timeZone,
          quietStartHour: profile.quietStartHour,
          quietEndHour: profile.quietEndHour,
          quoteValidityDays: profile.quoteValidityDays,
          followUpDays: profile.followUpDays,
          minimumChargeCents: profile.minimumChargeCents,
          taxRateBp: profile.taxRateBp,
          paymentTermsDays: profile.paymentTermsDays,
          depositPercent: profile.depositPercent,
          customerLinePrices: profile.customerLinePrices,
          language: profile.language,
        },
      });
    } catch (error) {
      return toolError(error);
    }
  },
});

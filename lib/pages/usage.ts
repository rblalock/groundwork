import { getProfile } from "../../core/profile";
import { usageNow } from "../../core/usage-limits";
import { monthlyUsage } from "../../core/usage-report";
import { HttpError, type AppCaller } from "../guards";

/**
 * The business's usage for a month (this one by default) and its last hour against its limits, for
 * owners and admins (and a super admin viewing it). Crew don't see it.
 */
export async function usageFor(caller: AppCaller, month?: string | null) {
  if (caller.role === "member") throw new HttpError(403, "NOT_PRIVILEGED", "Only the owner or an admin can do that.");
  const profile = await getProfile(caller.orgId);
  const [usage, hour] = await Promise.all([monthlyUsage(caller.orgId, { timeZone: profile.timeZone, month: month ?? undefined }), usageNow(caller.orgId)]);
  return { usage, hour };
}

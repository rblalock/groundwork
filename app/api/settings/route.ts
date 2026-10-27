import { requirePrivileged, route } from "@/lib/guards";
import { profilePatchSchema, updateSettingsFromApp } from "@/lib/pages/settings";

/** An owner or admin changes the business profile. Only fields that differ are saved. */
export const PATCH = route(async (request: Request) => {
  const caller = await requirePrivileged(request.headers);
  const patch = profilePatchSchema.parse(await request.json().catch(() => null));
  const { profile, changed } = await updateSettingsFromApp(caller, patch);
  return Response.json({ profile, changed });
});

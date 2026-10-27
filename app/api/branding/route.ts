import { requirePrivileged, route } from "@/lib/guards";
import { brandingPatchSchema, updateBrandingFromApp } from "@/lib/pages/branding";

/** An owner or admin changes how the business's PDFs look. Only settings that differ are saved. */
export const PATCH = route(async (request: Request) => {
  const caller = await requirePrivileged(request.headers);
  const patch = brandingPatchSchema.parse(await request.json().catch(() => null));
  return Response.json(await updateBrandingFromApp(caller, patch));
});

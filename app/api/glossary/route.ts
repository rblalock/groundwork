import { requirePrivileged, route } from "@/lib/guards";
import { replaceGlossaryFromApp } from "@/lib/pages/settings";

/** An owner or admin saves the business's glossary: the whole list, as the Settings page shows it. */
export const PUT = route(async (request: Request) => {
  const caller = await requirePrivileged(request.headers);
  const terms = await replaceGlossaryFromApp(caller, await request.json().catch(() => null));
  return Response.json({ terms });
});

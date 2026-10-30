import { requirePrivileged, route } from "@/lib/guards";
import { routeDaysFromApp } from "@/lib/pages/schedule";

/** An owner or admin asks for route days: a proposal to put each area's recurring work on one weekday. */
export const POST = route(async (request: Request) => {
  const caller = await requirePrivileged(request.headers);
  return Response.json(await routeDaysFromApp(caller));
});

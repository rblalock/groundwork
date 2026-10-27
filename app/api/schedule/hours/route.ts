import { requirePrivileged, route } from "@/lib/guards";
import { hoursFor, hoursSchema, setHoursFromApp } from "@/lib/pages/schedule";

/** The business's working hours and each member's. */
export const GET = route(async (request: Request) => {
  const caller = await requirePrivileged(request.headers);
  return Response.json(await hoursFor(caller));
});

/** An owner or admin sets the business's hours, or one member's own (null puts them back on the business's). */
export const PUT = route(async (request: Request) => {
  const caller = await requirePrivileged(request.headers);
  const input = hoursSchema.parse(await request.json().catch(() => null));
  return Response.json(await setHoursFromApp(caller, input));
});

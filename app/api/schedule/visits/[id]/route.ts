import { requirePrivileged, route } from "@/lib/guards";
import { rescheduleFromApp, rescheduleSchema } from "@/lib/pages/schedule";

/** An owner or admin moves a visit, changes how long it is, or changes who goes. */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  const input = rescheduleSchema.parse(await request.json().catch(() => null));
  return Response.json({ visit: await rescheduleFromApp(caller, (await params).id, input) });
});

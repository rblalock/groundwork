import { requirePrivileged, route } from "@/lib/guards";
import { closeJobFromApp, closeSchema } from "@/lib/pages/schedule";

/** An owner or admin closes a piece of work: completed or cancelled. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  const input = closeSchema.parse(await request.json().catch(() => null));
  return Response.json(await closeJobFromApp(caller, (await params).id, input));
});

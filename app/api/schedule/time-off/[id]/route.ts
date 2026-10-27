import { requireMember, route } from "@/lib/guards";
import { removeTimeOffFromApp } from "@/lib/pages/schedule";

/** Takes time off back off the schedule; crew only their own. */
export const DELETE = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  await removeTimeOffFromApp(caller, (await params).id);
  return Response.json({ ok: true });
});

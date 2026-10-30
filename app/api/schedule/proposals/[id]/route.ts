import { requirePrivileged, route } from "@/lib/guards";
import { proposalFromApp, proposalSchema } from "@/lib/pages/schedule";

/** An owner or admin applies a proposal to move stops (all, or the ones kept) or drops it. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  const input = proposalSchema.parse(await request.json().catch(() => null));
  return Response.json(await proposalFromApp(caller, (await params).id, input));
});

import { requireMember, route } from "@/lib/guards";
import { resendToCrewFromApp } from "@/lib/pages/schedule";

/** An owner or admin texts a visit's crew its booking again, with the checklist and photos as they are now. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  return Response.json(await resendToCrewFromApp(caller, (await params).id));
});

import { requireMember, route } from "@/lib/guards";
import { removeDrawnFromApp } from "@/lib/pages/quotes";

/** Takes an outline drawn by hand, and on no line, off the photo. */
export const DELETE = route(async (request: Request, { params }: { params: Promise<{ id: string; pricedId: string; candidateId: string }> }) => {
  const caller = await requireMember(request.headers);
  const { id, pricedId, candidateId } = await params;
  return Response.json(await removeDrawnFromApp(caller, id, pricedId, candidateId));
});

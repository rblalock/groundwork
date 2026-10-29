import { z } from "zod";
import { requireMember, route } from "@/lib/guards";
import { assignPricedPhotoFromApp, pricedPhotoEditor } from "@/lib/pages/quotes";

type Params = { params: Promise<{ id: string; pricedId: string }> };

const body = z.object({
  assignments: z.array(z.object({ candidateId: z.string().min(1).max(64), lineIndexes: z.array(z.number().int().min(0)).max(200) })).max(1000),
});

/** What the quote page's priced photo editor shows, for anyone who may see the quote. */
export const GET = route(async (request: Request, { params }: Params) => {
  const caller = await requireMember(request.headers);
  const { id, pricedId } = await params;
  return Response.json(await pricedPhotoEditor(caller, id, pricedId));
});

/** Puts each of the photo's objects on the lines listed for it (an object not listed is on none), and draws the photo again. */
export const PUT = route(async (request: Request, { params }: Params) => {
  const caller = await requireMember(request.headers);
  const { id, pricedId } = await params;
  const { assignments } = body.parse(await request.json().catch(() => null));
  return Response.json(await assignPricedPhotoFromApp(caller, id, pricedId, assignments));
});

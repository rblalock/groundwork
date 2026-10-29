import { z } from "zod";
import { requireMember, route } from "@/lib/guards";
import { findInPricedPhotoFromApp } from "@/lib/pages/quotes";

const coordinate = z.number().finite();
const body = z.object({
  phrase: z.string(),
  box: z.object({ left: coordinate, top: coordinate, right: coordinate, bottom: coordinate }).optional(),
  lineIndex: z.number().int().min(0).optional(),
});

/** Asks SAM for one more thing on the photo, inside the box when one is given and onto the line when one is named. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string; pricedId: string }> }) => {
  const caller = await requireMember(request.headers);
  const { id, pricedId } = await params;
  const ask = body.parse(await request.json().catch(() => null));
  return Response.json(await findInPricedPhotoFromApp(caller, id, pricedId, ask));
});

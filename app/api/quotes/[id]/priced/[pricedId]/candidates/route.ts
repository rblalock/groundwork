import { z } from "zod";
import { MAX_DRAWN_POINTS } from "@/core/priced-photo-select";
import { requireMember, route } from "@/lib/guards";
import { drawInPricedPhotoFromApp } from "@/lib/pages/quotes";

const coordinate = z.number().finite();
const body = z.object({
  points: z.array(z.object({ x: coordinate, y: coordinate })).max(MAX_DRAWN_POINTS),
  lineIndex: z.number().int().min(0).optional(),
});

/** Keeps an outline the member drew on the photo, onto the line when one is named, and draws the photo again without SAM. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string; pricedId: string }> }) => {
  const caller = await requireMember(request.headers);
  const { id, pricedId } = await params;
  const ask = body.parse(await request.json().catch(() => null));
  return Response.json(await drawInPricedPhotoFromApp(caller, id, pricedId, ask));
});

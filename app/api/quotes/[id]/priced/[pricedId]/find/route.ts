import { z } from "zod";
import { MAX_PROMPT_POINTS } from "@/core/priced-photo-select";
import { requireMember, route } from "@/lib/guards";
import { findInPricedPhotoFromApp } from "@/lib/pages/quotes";

const coordinate = z.number().finite();
const body = z
  .object({
    phrase: z.string().optional(),
    box: z.object({ left: coordinate, top: coordinate, right: coordinate, bottom: coordinate }).optional(),
    points: z.array(z.object({ x: coordinate, y: coordinate, negative: z.boolean().optional() })).max(MAX_PROMPT_POINTS).optional(),
    lineIndex: z.number().int().min(0).optional(),
    replace: z.string().min(1).optional(),
  })
  .refine((ask) => ask.phrase !== undefined || ask.box !== undefined, "a phrase or a box");

/**
 * Asks SAM for one more thing on the photo: a phrase, kept inside the box when one is given; or, with
 * no phrase, the one object the box and points name, in place of `replace` when that's the wrong one.
 * Onto the line when one is named.
 */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string; pricedId: string }> }) => {
  const caller = await requireMember(request.headers);
  const { id, pricedId } = await params;
  const ask = body.parse(await request.json().catch(() => null));
  return Response.json(await findInPricedPhotoFromApp(caller, id, pricedId, ask));
});

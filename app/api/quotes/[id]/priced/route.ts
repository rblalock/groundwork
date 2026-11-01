import { HttpError, requireMember, route } from "@/lib/guards";
import { pricePhotoFromApp } from "@/lib/pages/quotes";

/**
 * Anyone on the team prices every photo on the quote from its page (a form post), then goes back to the
 * page's priced photo section, with what happened when it isn't all done: `partial` when some photos
 * couldn't be priced.
 */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  const id = (await params).id;
  let outcome: string;
  try {
    const result = await pricePhotoFromApp(caller, id);
    outcome = result.photos === null ? result.reason : result.photos.every((photo) => photo.pricedPhotoId !== null) ? "done" : "partial";
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error("priced photo: pricing from the quote page failed", error);
    outcome = "failed";
  }
  return Response.redirect(new URL(`/quotes/${encodeURIComponent(id)}?priced=${outcome}#priced-photo`, request.url), 303);
});

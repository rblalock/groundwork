import { HttpError, requireMember, route } from "@/lib/guards";
import { pricePhotoFromApp } from "@/lib/pages/quotes";

/**
 * Anyone on the team prices the quote's latest photo from its page (a form post), then goes back to the
 * page's priced photo section, with what happened when there's nothing to show.
 */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  const id = (await params).id;
  let outcome: string;
  try {
    const result = await pricePhotoFromApp(caller, id);
    outcome = result.pricedPhotoId === null ? result.reason : "done";
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error("priced photo: pricing from the quote page failed", error);
    outcome = "failed";
  }
  return Response.redirect(new URL(`/quotes/${encodeURIComponent(id)}?priced=${outcome}#priced-photo`, request.url), 303);
});

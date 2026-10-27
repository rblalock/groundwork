import { requireMember, route } from "@/lib/guards";
import { fileResponse, pricedPhotoFile } from "@/lib/pages/quotes";

/** One of the quote's priced photos, for anyone who may see the quote. */
export const GET = route(async (request: Request, { params }: { params: Promise<{ id: string; pricedId: string }> }) => {
  const caller = await requireMember(request.headers);
  const { id, pricedId } = await params;
  return fileResponse(await pricedPhotoFile(caller, id, pricedId));
});

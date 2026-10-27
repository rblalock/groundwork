import { requireMember, route } from "@/lib/guards";
import { fileResponse, quoteFile } from "@/lib/pages/quotes";

/** A photo on the quote, for anyone who may see the quote. */
export const GET = route(async (request: Request, { params }: { params: Promise<{ id: string; photoId: string }> }) => {
  const caller = await requireMember(request.headers);
  const { id, photoId } = await params;
  return fileResponse(await quoteFile(caller, id, { photoId }));
});

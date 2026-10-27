import { requireMember, route } from "@/lib/guards";
import { fileResponse, quoteFile } from "@/lib/pages/quotes";

/** The quote's current PDF, for anyone who may see the quote. */
export const GET = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  return fileResponse(await quoteFile(caller, (await params).id, { pdf: true }));
});

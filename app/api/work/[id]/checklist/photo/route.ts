import { HttpError, requireMember, route } from "@/lib/guards";
import { fileResponse } from "@/lib/pages/quotes";
import { checklistPhotoFile } from "@/lib/pages/work";

/**
 * One of the checklist's priced photos as crew get it: quantities only, no prices or total, drawn from the
 * kept outlines in the viewer's language. `n` is its number among the quote's priced photos (the first
 * when left off); `v` changes when it's drawn again, so a redrawn photo is a new address.
 */
export const GET = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  const { id } = await params;
  const n = new URL(request.url).searchParams.get("n") ?? "1";
  if (!/^[1-9]\d{0,2}$/.test(n)) throw new HttpError(400, "INVALID_INPUT", "n is a photo's number.");
  const file = await checklistPhotoFile(caller, id, Number(n));
  if (!file) throw new HttpError(404, "NOT_FOUND", "No priced photo.");
  return fileResponse(file, "private, max-age=3600");
});

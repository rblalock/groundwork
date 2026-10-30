import { HttpError, requireMember, route } from "@/lib/guards";
import { fileResponse } from "@/lib/pages/quotes";
import { checklistPhotoFile } from "@/lib/pages/work";

/**
 * The checklist's priced photo as crew get it: quantities only, no prices or total, drawn from the kept
 * outlines in the viewer's language. `v` is the photo's edit time, so a redrawn photo is a new address.
 */
export const GET = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  const { id } = await params;
  const file = await checklistPhotoFile(caller, id);
  if (!file) throw new HttpError(404, "NOT_FOUND", "No priced photo.");
  return fileResponse(file, "private, max-age=3600");
});

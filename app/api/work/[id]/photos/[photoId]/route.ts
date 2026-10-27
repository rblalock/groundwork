import { requireMember, route } from "@/lib/guards";
import { fileResponse } from "@/lib/pages/quotes";
import { removeWorkPhotoFromApp, workPhotoFile } from "@/lib/pages/work";

type Params = { params: Promise<{ id: string; photoId: string }> };

/** A photo on the work, for anyone on the team. */
export const GET = route(async (request: Request, { params }: Params) => {
  const caller = await requireMember(request.headers);
  const { id, photoId } = await params;
  return fileResponse(await workPhotoFile(caller, id, photoId));
});

/** Takes a photo off the work: whoever added it, or an owner or admin. */
export const DELETE = route(async (request: Request, { params }: Params) => {
  const caller = await requireMember(request.headers);
  const { id, photoId } = await params;
  await removeWorkPhotoFromApp(caller, id, photoId);
  return Response.json({ ok: true });
});

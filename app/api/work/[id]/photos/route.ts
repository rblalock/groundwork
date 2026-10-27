import { HttpError, requireMember, route } from "@/lib/guards";
import { PHOTO_MAX_BYTES } from "@/lib/pages/photo-upload";
import { addWorkPhotoFromApp } from "@/lib/pages/work";

/** A photo uploaded on the work's page (one per request, JPEG, PNG, or HEIC up to 4 MB), optionally on one of its visits. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  // Refuse a body plainly too big before reading it.
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > PHOTO_MAX_BYTES + 64 * 1024) throw new HttpError(413, "PHOTO_TOO_LARGE", "That photo is too big.");
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "INVALID_INPUT", "Attach a photo.");
  const visitId = form?.get("visitId");
  const photo = await addWorkPhotoFromApp(caller, (await params).id, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }, typeof visitId === "string" ? visitId : undefined);
  return Response.json({ photoId: photo.id }, { status: 201 });
});

import { HttpError, requireMember, route } from "@/lib/guards";
import { addQuotePhotoFromApp, QUOTE_PHOTO_MAX_BYTES } from "@/lib/pages/quote-editor";

/** A photo uploaded on the quote's page (one per request, JPEG, PNG, or HEIC up to 4 MB), as a new revision. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  // Refuse a body plainly too big before reading it.
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > QUOTE_PHOTO_MAX_BYTES + 64 * 1024) throw new HttpError(413, "PHOTO_TOO_LARGE", "That photo is too big.");
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "INVALID_INPUT", "Attach a photo.");
  const result = await addQuotePhotoFromApp(caller, (await params).id, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
  return Response.json(result, { status: 201 });
});

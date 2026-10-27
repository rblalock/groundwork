import { HttpError, requireMember, route } from "@/lib/guards";
import { CHAT_PDF_MAX_BYTES, storeChatAttachment } from "@/lib/pages/chat-attachment";
import { PHOTO_MAX_BYTES } from "@/lib/pages/photo-upload";

const ACCEPTED = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"]);

/** A photo (up to 4 MB) or PDF (up to 3 MB) attached in web chat, one per request, stored before the message is sent. */
export const POST = route(async (request: Request) => {
  const caller = await requireMember(request.headers);
  // Refuse a body plainly too big before reading it.
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > PHOTO_MAX_BYTES + 64 * 1024) throw new HttpError(413, "FILE_TOO_LARGE", "That file is too big.");
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "INVALID_INPUT", "Attach a photo or a PDF.");
  if (file.type && !ACCEPTED.has(file.type)) throw new HttpError(415, "FILE_UNSUPPORTED", "Attach a photo or a PDF.");
  if (file.type === "application/pdf" && file.size > CHAT_PDF_MAX_BYTES) {
    throw new HttpError(413, "FILE_TOO_LARGE", "That PDF is too big. Send one under 3 MB.");
  }
  const result = await storeChatAttachment(caller, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
  return Response.json(result, { status: 201 });
});

import { HttpError, requireMember, route } from "@/lib/guards";
import { addNoteFileFromApp, NOTE_FILE_MAX_BYTES } from "@/lib/pages/notes";

/** A member keeps a file (a PDF, JPEG, or PNG up to 4 MB) on a note they may change. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  // Refuse a body plainly too big before reading it.
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > NOTE_FILE_MAX_BYTES + 64 * 1024) throw new HttpError(413, "FILE_TOO_LARGE", "That file is too big.");
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "INVALID_INPUT", "Attach a file.");
  const note = await addNoteFileFromApp(caller, (await params).id, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
  return Response.json({ note });
});

import { requireMember, route } from "@/lib/guards";
import { noteBodySchema, saveNoteFromApp } from "@/lib/pages/notes";

/** A member changes or archives a note: owners and admins any, crew their own. */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  const body = noteBodySchema.parse(await request.json().catch(() => null));
  return Response.json({ note: await saveNoteFromApp(caller, (await params).id, body) });
});

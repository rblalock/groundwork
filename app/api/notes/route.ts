import { requireMember, route } from "@/lib/guards";
import { noteBodySchema, saveNoteFromApp } from "@/lib/pages/notes";

/** A member adds a note: business-wide (owners and admins), or on a customer they may write on. */
export const POST = route(async (request: Request) => {
  const caller = await requireMember(request.headers);
  const body = noteBodySchema.parse(await request.json().catch(() => null));
  return Response.json({ note: await saveNoteFromApp(caller, undefined, body) });
});

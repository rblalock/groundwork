import { requireMember, route } from "@/lib/guards";
import { textedFor } from "@/lib/pages/assistant";

/** What the assistant texted the signed-in member on its own, for their Assistant page. Theirs only. */
export const GET = route(async (request: Request) => {
  const caller = await requireMember(request.headers);
  return Response.json({ texts: await textedFor(caller) });
});

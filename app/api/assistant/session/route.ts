import { z } from "zod";
import { requireMember, route } from "@/lib/guards";
import { replaceLostSession } from "@/lib/pages/assistant";

const body = z.object({ ended: z.string().min(1).max(200) });

/**
 * The session to use for the signed-in member's thread or job whose send was just refused on `ended`:
 * a fresh one when eve no longer runs it, or null when it's kept (lib/pages/assistant.ts).
 */
export const POST = route(async (request: Request) => {
  const caller = await requireMember(request.headers);
  const { ended } = body.parse(await request.json());
  return Response.json({ sessionId: await replaceLostSession(caller, ended, request.headers.get("cookie") ?? "") });
});

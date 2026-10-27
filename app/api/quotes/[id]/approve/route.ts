import { z } from "zod";
import { requirePrivileged, route } from "@/lib/guards";
import { approveFromApp } from "@/lib/pages/quotes";

const body = z.object({ revision: z.number().int().min(1) });

/** An owner or admin approves the revision they're looking at. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  const { revision } = body.parse(await request.json().catch(() => null));
  const quote = await approveFromApp(caller, (await params).id, revision);
  return Response.json({ quote });
});

import { z } from "zod";
import { requirePrivileged, route } from "@/lib/guards";
import { QUOTE_OUTCOMES, setOutcomeFromApp } from "@/lib/pages/quotes";

const body = z.object({ outcome: z.enum(QUOTE_OUTCOMES) });

/** An owner or admin marks a quote sent, won, lost, or void. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  const { outcome } = body.parse(await request.json().catch(() => null));
  const quote = await setOutcomeFromApp(caller, (await params).id, outcome);
  return Response.json({ quote });
});

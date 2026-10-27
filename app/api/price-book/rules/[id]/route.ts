import { z } from "zod";
import { requirePrivileged, route } from "@/lib/guards";
import { ruleActionFromApp } from "@/lib/pages/pricebook";

const body = z.object({ action: z.enum(["accept", "retire"]) });

/** An owner or admin accepts a crew suggestion or retires a rule. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  const { action } = body.parse(await request.json().catch(() => null));
  const rule = await ruleActionFromApp(caller, (await params).id, action);
  return Response.json({ rule });
});

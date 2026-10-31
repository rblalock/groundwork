import { z } from "zod";
import { requirePrivileged, route } from "@/lib/guards";
import { ruleActionFromApp, rulePatchSchema, updateRuleFromApp } from "@/lib/pages/pricebook";

const body = z.object({ action: z.enum(["accept", "retire"]) });

/** An owner or admin accepts a crew suggestion or retires a rule. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  const { action } = body.parse(await request.json().catch(() => null));
  const rule = await ruleActionFromApp(caller, (await params).id, action);
  return Response.json({ rule });
});

/** An owner or admin changes an active or suggested rule's words and kind, from the version the page showed. */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  const patch = rulePatchSchema.parse(await request.json().catch(() => null));
  return Response.json({ rule: await updateRuleFromApp(caller, (await params).id, patch) });
});

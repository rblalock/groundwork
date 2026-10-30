import { z } from "zod";
import { requireMember, route } from "@/lib/guards";
import { tickChecklistFromApp } from "@/lib/pages/work";

type Params = { params: Promise<{ id: string }> };

const body = z.object({ itemIds: z.array(z.string().min(1).max(64)).min(1).max(100), undo: z.boolean().optional() });

/** Ticks checklist items done, or unticks them with `undo`, for anyone on the team. */
export const PUT = route(async (request: Request, { params }: Params) => {
  const caller = await requireMember(request.headers);
  const { id } = await params;
  const { itemIds, undo } = body.parse(await request.json().catch(() => null));
  return Response.json(await tickChecklistFromApp(caller, id, itemIds, undo ?? false));
});

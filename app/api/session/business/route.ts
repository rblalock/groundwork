import { z } from "zod";
import { requireViewer, route, setActiveBusiness } from "@/lib/guards";

const body = z.object({ orgId: z.string().min(1).max(100) });

/** Opens a business for this session: one of the viewer's own, or any for a super admin. */
export const POST = route(async (request: Request) => {
  const viewer = await requireViewer(request.headers);
  const { orgId } = body.parse(await request.json().catch(() => null));
  const business = await setActiveBusiness(viewer, orgId);
  return Response.json({ business });
});

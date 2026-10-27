import { z } from "zod";
import { setSuspended } from "@/core/organizations";
import { HttpError, requireSuperAdmin, route } from "@/lib/guards";

const body = z.object({ suspended: z.boolean() });

/**
 * Pauses or resumes a business, for super admins. Paused, its members' texts start no turns, the web
 * app shows them a paused screen, and nothing texts them; payments still record.
 */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const viewer = await requireSuperAdmin(request.headers);
  const { id } = await params;
  const { suspended } = body.parse(await request.json().catch(() => null));
  try {
    const org = await setSuspended(id, suspended);
    console.info("admin: business suspension changed", { orgId: org.id, suspended, by: viewer.userId });
    return Response.json({ business: { id: org.id, suspended: org.suspended, suspendedAt: org.suspendedAt?.toISOString() ?? null } });
  } catch (error) {
    if (error instanceof Error && error.message === "NO_SUCH_BUSINESS") throw new HttpError(404, "NO_SUCH_BUSINESS", "That business doesn't exist.");
    throw error;
  }
});

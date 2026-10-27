import { z } from "zod";
import { getOrganization } from "@/core/organizations";
import { setUsageLimits, usageNow } from "@/core/usage-limits";
import { HttpError, requireSuperAdmin, route } from "@/lib/guards";

const limit = z.number().int().nullable().optional();
const body = z.object({ hourlyTurns: limit, hourlyOutputTokens: limit, concurrentTurns: limit }).strict();

/**
 * A business's usage limits, for super admins: hourly turns, hourly output tokens, and turns at once.
 * A number sets the business's own; null puts it back to the app's default. Raising one is how a super
 * admin lets a business do more: nobody bypasses them.
 */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const viewer = await requireSuperAdmin(request.headers);
  const { id } = await params;
  const patch = body.parse(await request.json().catch(() => null));
  if (!(await getOrganization(id))) throw new HttpError(404, "NO_SUCH_BUSINESS", "That business doesn't exist.");
  try {
    const overrides = await setUsageLimits(id, patch, viewer.userId);
    console.info("admin: usage limits changed", { orgId: id, overrides, by: viewer.userId });
    const { limits, defaults } = await usageNow(id);
    return Response.json({ overrides, limits, defaults });
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_LIMIT") throw new HttpError(400, "INVALID_LIMIT", "One of those limits is out of range.");
    throw error;
  }
});

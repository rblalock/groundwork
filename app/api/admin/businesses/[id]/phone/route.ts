import { z } from "zod";
import { changeMemberPhone } from "@/core/business-admin";
import { HttpError, requireSuperAdmin, route } from "@/lib/guards";

const body = z.object({ memberId: z.string(), from: z.string(), to: z.string() });

/**
 * Moves a member to a new phone, for super admins: an owner who changed numbers can't sign in to do it
 * themselves. Answers with the line they text from the new phone to activate it.
 */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const viewer = await requireSuperAdmin(request.headers);
  const { id } = await params;
  const input = body.parse(await request.json().catch(() => null));
  try {
    const phone = await changeMemberPhone(id, input);
    console.info("admin: member phone changed", { orgId: id, memberId: input.memberId, by: viewer.userId });
    return Response.json({ phone });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "NO_SUCH_BUSINESS") throw new HttpError(404, code, "That business doesn't exist.");
    if (code === "MEMBER_NOT_FOUND" || code === "PHONE_NOT_FOUND") throw new HttpError(404, code, "That number isn't this member's any more. Reload and try again.");
    if (code === "INVALID_PHONE") throw new HttpError(400, code, "That isn't a phone number.");
    if (code === "PHONE_IN_USE") throw new HttpError(409, code, "That number already belongs to someone on the app.");
    console.error("admin: changing a member's phone failed", { orgId: id }, error);
    throw new HttpError(502, "PHONE_CHANGE_FAILED", "Couldn't register the new number. Try again.");
  }
});

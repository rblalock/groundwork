import { removeBusinessInbox } from "@/core/business-admin";
import { createBusinessInbox } from "@/core/email-intake";
import { HttpError, requireSuperAdmin, route } from "@/lib/guards";

/**
 * Makes the business's email inbox, for super admins: where its members forward emails to the assistant.
 * A business that has one keeps it. The same as `npm run email:inbox`.
 */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const viewer = await requireSuperAdmin(request.headers);
  const { id } = await params;
  try {
    const inbox = await createBusinessInbox(id);
    console.info("admin: business inbox", inbox.created ? "made" : "already there", { orgId: id, by: viewer.userId });
    return Response.json({ inbox: { address: inbox.address, created: inbox.created } }, { status: inbox.created ? 201 : 200 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "NO_SUCH_BUSINESS") throw new HttpError(404, "NO_SUCH_BUSINESS", "That business doesn't exist.");
    if (code === "AGENTMAIL_NOT_CONFIGURED") throw new HttpError(503, "AGENTMAIL_NOT_CONFIGURED", "AgentMail isn't set up: set AGENTMAIL_API_KEY and AGENTMAIL_WEBHOOK_SECRET.");
    throw error;
  }
});

/** Deletes the business's email inbox and its mail, for super admins. Another can be made after. */
export const DELETE = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const viewer = await requireSuperAdmin(request.headers);
  const { id } = await params;
  try {
    const { removed } = await removeBusinessInbox(id);
    console.info("admin: business inbox", removed ? "removed" : "already gone", { orgId: id, by: viewer.userId });
    return Response.json({ inbox: null });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "NO_SUCH_BUSINESS") throw new HttpError(404, "NO_SUCH_BUSINESS", "That business doesn't exist.");
    if (code === "AGENTMAIL_NOT_CONFIGURED") throw new HttpError(503, "AGENTMAIL_NOT_CONFIGURED", "AgentMail isn't set up: set AGENTMAIL_API_KEY and AGENTMAIL_WEBHOOK_SECRET.");
    throw error;
  }
});

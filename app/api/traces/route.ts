import { traceFor } from "@/core/turn-traces";
import { HttpError, requireMember, route } from "@/lib/guards";

/**
 * One turn's model and token totals, for the chat's "Under the hood" (its steps come from the messages
 * the chat already has). Scoped to the caller's business.
 */
export const GET = route(async (request: Request) => {
  const caller = await requireMember(request.headers);
  const params = new URL(request.url).searchParams;
  const sessionId = params.get("sessionId")?.trim();
  const turnId = params.get("turnId")?.trim();
  if (!sessionId || !turnId) throw new HttpError(400, "INVALID_INPUT", "Name the session and the turn.");
  const trace = await traceFor(caller.orgId, sessionId, turnId);
  if (!trace) throw new HttpError(404, "TRACE_NOT_FOUND", "No trace for that turn.");
  return Response.json({
    modelId: trace.modelId,
    status: trace.status,
    usage: trace.usage,
    startedAt: trace.startedAt.toISOString(),
    finishedAt: trace.finishedAt?.toISOString() ?? null,
    stepCount: trace.steps.length,
  });
});

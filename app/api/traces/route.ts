import { traceFor } from "@/core/turn-traces";
import { HttpError, requireMember, route } from "@/lib/guards";
import { readableConversation } from "@/lib/pages/translation";

/**
 * One turn's model and token counts, for the chat's "Under the hood" (its steps come from the messages
 * the chat already has). Only for a turn in a conversation the caller may read: their thread or one of
 * their jobs. A trace with no conversation (an eval's) isn't shown here.
 */
export const GET = route(async (request: Request) => {
  const caller = await requireMember(request.headers);
  const params = new URL(request.url).searchParams;
  const sessionId = params.get("sessionId")?.trim();
  const turnId = params.get("turnId")?.trim();
  if (!sessionId || !turnId) throw new HttpError(400, "INVALID_INPUT", "Name the session and the turn.");
  const trace = await traceFor(caller.orgId, sessionId, turnId);
  if (!trace?.conversationId) throw new HttpError(404, "TRACE_NOT_FOUND", "No trace for that turn.");
  await readableConversation(caller, trace.conversationId);
  const usage = trace.usage
    ? {
        inputTokens: trace.usage.inputTokens ?? 0,
        outputTokens: trace.usage.outputTokens ?? 0,
        cacheReadTokens: trace.usage.cacheReadTokens ?? 0,
        cacheWriteTokens: trace.usage.cacheWriteTokens ?? 0,
      }
    : null;
  return Response.json(
    {
      modelId: trace.modelId,
      status: trace.status,
      usage,
      startedAt: trace.startedAt.toISOString(),
      finishedAt: trace.finishedAt?.toISOString() ?? null,
      stepCount: trace.steps.filter((step) => step.kind !== "input").length,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
});

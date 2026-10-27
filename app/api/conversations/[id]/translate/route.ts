import { usageLimitMessage } from "@/lib/eve-auth";
import { requireMember, route } from "@/lib/guards";
import { translateForApp, TranslationLimitedError } from "@/lib/pages/translation";

/**
 * A member translates a batch of a conversation's texts, by id, for the translated view. The server
 * reads the texts from the conversation, which the member must be able to read.
 * Over the business's hourly usage limit, a 429 with when to try again.
 */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  const { id } = await params;
  try {
    const result = await translateForApp(caller, id, await request.json().catch(() => null), request.headers);
    return Response.json(result, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (!(error instanceof TranslationLimitedError)) throw error;
    const retryAfterSeconds = Math.max(1, Math.ceil((error.retryAt.getTime() - Date.now()) / 1000));
    return Response.json(
      { error: usageLimitMessage(caller.language), code: "USAGE_LIMIT", retryAfterSeconds },
      { status: 429, headers: { "retry-after": String(retryAfterSeconds) } },
    );
  }
});

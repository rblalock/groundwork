// Usage receipts: one row per model call (`usage_receipts`), with the business, member, conversation,
// turn, and channel it ran for, its tokens, and an estimated cost. agents/assistant/agent/agent.ts binds each step's
// model to the turn (`turnMeter`); the metered model (core/metered-model.ts) calls back here when
// the provider reports usage. A call that is replayed is one receipt (`event_key`).
import { and, eq } from "drizzle-orm";
import { conversations, usageReceipts } from "../schema/schema";
import { db, newId } from "./db";
import { APP_JOB, APP_WEB, resolveCaller } from "./members";
import type { CallUsage } from "./metered-model";
import { currentModel, estimateCostUsd, ratesFor } from "./model-pricing";
import { extendLease, type UsageChannel } from "./usage-limits";

/** The auth a turn runs under, as eve gives it to hooks and resolvers. Structural, for tests. */
export type TurnAuth = { authenticator: string; principalId: string; principalType?: string; attributes?: Record<string, unknown> } | null | undefined;

const attr = (auth: TurnAuth, key: string): string | null => {
  const value = auth?.attributes?.[key];
  return typeof value === "string" && value ? value : null;
};

/** Where a turn came from. A forwarded email's turn runs in the member's iMessage thread, marked `origin: "email"`. */
export function channelOf(auth: TurnAuth): UsageChannel {
  switch (auth?.authenticator) {
    case "photon-imessage":
      return attr(auth, "origin") === "email" ? "email" : "text";
    case APP_WEB:
      return "web";
    case APP_JOB:
      return "job";
    case "local-dev":
      return "local";
    default:
      return auth?.principalType === "schedule" ? "schedule" : "other";
  }
}

/** The admitted turn a call counts against, if the channel reserved one. */
export const reservationOf = (auth: TurnAuth): string | null => attr(auth, "reservationId");

export type TurnRef = { auth: TurnAuth; eveSessionId: string; turnId: string | null; stepIndex: number | null };

/**
 * Who a call is for: the business and member on the turn's auth (local dev's owner fallback resolves
 * them), and the conversation, when it is that member's and bound to this session. A call with no
 * business can't be billed to one, and isn't recorded.
 */
export async function attributionFor(ref: TurnRef): Promise<{ orgId: string; memberId: string | null; conversationId: string | null } | null> {
  let orgId = attr(ref.auth, "orgId");
  let memberId = attr(ref.auth, "memberId");
  if (!orgId && ref.auth) {
    const caller = await resolveCaller({ ...ref.auth, attributes: ref.auth.attributes ?? {} }).catch(() => null);
    if (caller) {
      orgId = caller.orgId;
      memberId = caller.memberId;
    }
  }
  if (!orgId) return null;
  const [row] = await db()
    .select({ id: conversations.id, memberId: conversations.memberId })
    .from(conversations)
    .where(and(eq(conversations.orgId, orgId), eq(conversations.eveSessionId, ref.eveSessionId)))
    .limit(1);
  const conversationId = row && (!memberId || row.memberId === memberId) ? row.id : null;
  return { orgId, memberId, conversationId };
}

type Receipt = {
  orgId: string;
  memberId: string | null;
  conversationId: string | null;
  eveSessionId: string | null;
  turnId: string | null;
  stepIndex: number | null;
  reservationId: string | null;
  channel: UsageChannel;
  eventKey: string;
};

async function insertReceipt(who: Receipt, usage: CallUsage, options: { deployment?: string; now?: Date }): Promise<{ recorded: boolean }> {
  const deployment = options.deployment ?? currentModel();
  const { rates, source } = ratesFor(deployment);
  const now = options.now ?? new Date();
  const inserted = await db()
    .insert(usageReceipts)
    .values({
      id: newId("use"),
      ...who,
      kind: usage.kind,
      deployment,
      responseModel: usage.responseModel,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      estimatedCostUsd: estimateCostUsd(usage, rates),
      priceSource: source,
      createdAt: now,
    })
    .onConflictDoNothing({ target: [usageReceipts.orgId, usageReceipts.eventKey] })
    .returning({ id: usageReceipts.id });
  if (who.reservationId) await extendLease(who.orgId, who.reservationId, now);
  return { recorded: inserted.length > 0 };
}

/** Records one call's receipt, once per `eventKey`. Returns whether this call wrote it. */
export async function recordUsage(ref: TurnRef, usage: CallUsage, options: { deployment?: string; now?: Date } = {}): Promise<{ recorded: boolean }> {
  const who = await attributionFor(ref);
  if (!who) {
    console.warn("usage: a model call with no business was not recorded", { eveSessionId: ref.eveSessionId, channel: channelOf(ref.auth) });
    return { recorded: false };
  }
  const eventKey = [ref.eveSessionId, ref.turnId ?? "-", ref.stepIndex ?? "-", usage.kind, usage.responseId ?? crypto.randomUUID()].join(":");
  return insertReceipt(
    {
      ...who,
      eveSessionId: ref.eveSessionId,
      turnId: ref.turnId,
      stepIndex: ref.stepIndex,
      reservationId: reservationOf(ref.auth),
      channel: channelOf(ref.auth),
      eventKey,
    },
    usage,
    options,
  );
}

/**
 * Records the receipt of a model call that isn't a turn's step (a translation), for the business and
 * member it ran for, against its admitted reservation (`admitModelCall`). Once per `callId`.
 */
export async function recordModelCall(
  call: { orgId: string; memberId: string | null; conversationId: string | null; reservationId: string; channel: UsageChannel; callId: string },
  usage: CallUsage,
  options: { deployment?: string; now?: Date } = {},
): Promise<{ recorded: boolean }> {
  return insertReceipt(
    {
      orgId: call.orgId,
      memberId: call.memberId,
      conversationId: call.conversationId,
      eveSessionId: null,
      turnId: null,
      stepIndex: null,
      reservationId: call.reservationId,
      channel: call.channel,
      eventKey: [call.channel, call.callId, usage.kind, usage.responseId ?? "-"].join(":"),
    },
    usage,
    options,
  );
}

/** What the agent's step resolver hands eve: the step's turn, so the metered model can bill it. */
export function turnMeter(event: unknown, ctx: { session: { id: string; auth: { current?: unknown } } }): TurnRef {
  const data = (event as { data?: { turnId?: unknown; stepIndex?: unknown } } | null)?.data;
  return {
    auth: (ctx.session.auth.current ?? null) as TurnAuth,
    eveSessionId: ctx.session.id,
    turnId: typeof data?.turnId === "string" ? data.turnId : null,
    stepIndex: typeof data?.stepIndex === "number" ? data.stepIndex : null,
  };
}

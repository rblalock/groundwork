// A member's conversations, as eve ran them: `agents/assistant/agent/hooks/persist.ts` hands every stream event here,
// and the kinds worth keeping land in `conversation_events`. Super admins read them on a business's
// Activity page; the inbound text queue reads them to learn whether eve got a text it handed over.
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { conversationEvents, conversations, members } from "../schema/schema";
import { db } from "./db";
import { APP_JOB, APP_WEB } from "./members";

export type ConversationEvent = typeof conversationEvents.$inferSelect;

/** The auth a turn runs under, as eve gives it to hooks. */
export type TurnAuth = { authenticator: string; principalId: string; attributes?: Record<string, unknown> } | null | undefined;

/** One eve stream event, as hooks receive it. Structural, so tests need no eve runtime. */
export type StreamEvent = { type: string; data?: unknown; meta: { id: string; at: string } };

export const RETENTION_DAYS = 180;
const TEXT_LIMIT = 500;
const TERMINAL = ["turn.completed", "turn.failed", "turn.cancelled"] as const;

const attr = (auth: TurnAuth, key: string): string | null => {
  const value = auth?.attributes?.[key];
  return typeof value === "string" && value ? value : null;
};

/** Where a turn came from: a text, a forwarded email, the web app, a job the thread drives, or local dev and evals. */
export function originOf(auth: TurnAuth): string {
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
      return "other";
  }
}

const truncate = (text: string, limit = TEXT_LIMIT) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

const SENSITIVE_KEY = /pass|secret|token|code|otp|pin\b|key|auth|cookie|session|card|cvv|ssn|account|routing|phone|email/i;

/**
 * A tool's input as it may be stored: the shape and short values, never anything secret-bearing. Keys
 * that name a secret, a code, a phone, or an email are replaced; strings are cut to 60 characters,
 * arrays to their first three items, and nesting below two levels is dropped.
 */
export function redactInput(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return truncate(value, 60);
  if (depth >= 2) return Array.isArray(value) ? `[${value.length} items]` : typeof value === "object" ? "{…}" : null;
  if (Array.isArray(value)) {
    const head = value.slice(0, 3).map((item) => redactInput(item, depth + 1));
    return value.length > 3 ? [...head, `…${value.length - 3} more`] : head;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redactInput(item, depth + 1);
    }
    return out;
  }
  return null;
}

/** The code a tool's `{ error }` output starts with (`QUOTE_NOT_FOUND: …` → `QUOTE_NOT_FOUND`). */
function errorCode(output: unknown): string | null {
  const error = (output as { error?: unknown } | null | undefined)?.error;
  if (typeof error !== "string") return null;
  const code = error.split(":")[0].trim();
  return /^[A-Z][A-Z0-9_]+$/.test(code) ? code : "ERROR";
}

/**
 * The conversation this session is, for this turn's member, or null. A web or job turn names its
 * conversation; a text's turn (or a local one) runs in the member's thread. Either way the
 * conversation must be the member's and bound to this very session: anything else is refused and
 * logged, so one session's events never land under another conversation.
 */
export async function conversationForSession(
  auth: TurnAuth,
  eveSessionId: string,
): Promise<{ orgId: string; memberId: string; conversationId: string } | null> {
  const orgId = attr(auth, "orgId");
  const memberId = attr(auth, "memberId");
  if (!orgId || !memberId) return null;
  const named = attr(auth, "conversationId");
  const [row] = await db()
    .select({ id: conversations.id, eveSessionId: conversations.eveSessionId })
    .from(conversations)
    .where(
      and(
        eq(conversations.orgId, orgId),
        eq(conversations.memberId, memberId),
        named ? eq(conversations.id, named) : eq(conversations.kind, "thread"),
      ),
    )
    .limit(1);
  if (!row || row.eveSessionId !== eveSessionId) {
    console.warn("conversation events: session does not match its conversation, not recorded", {
      orgId,
      memberId,
      conversationId: named ?? row?.id ?? null,
      eveSessionId,
    });
    return null;
  }
  return { orgId, memberId, conversationId: row.id };
}

type Row = typeof conversationEvents.$inferInsert;

/** The rows one stream event becomes: none for the kinds we don't keep. */
async function rowsFor(event: StreamEvent, base: Omit<Row, "id" | "kind">): Promise<Row[]> {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const turnId = typeof data.turnId === "string" ? data.turnId : null;
  const row = (kind: string, extra: Partial<Row> = {}, suffix = ""): Row => ({
    ...base,
    id: `${event.meta.id}${suffix}`,
    kind,
    turnId,
    ...extra,
  });
  switch (event.type) {
    case "turn.started":
    case "message.received": {
      const text = typeof data.message === "string" ? data.message : "";
      const files = Array.isArray(data.parts) ? data.parts.filter((p) => (p as { type?: string }).type === "file").length : 0;
      return [row(event.type, { data: event.type === "message.received" ? { text: truncate(text), files } : {} })];
    }
    case "message.completed": {
      // A message that ends in tool calls is the model thinking aloud; only replies are kept.
      if (data.finishReason === "tool-calls") return [];
      const text = typeof data.message === "string" ? data.message : "";
      return [row("message.completed", { data: { text: truncate(text), finishReason: data.finishReason ?? null } })];
    }
    case "actions.requested": {
      const actions = Array.isArray(data.actions) ? (data.actions as Array<Record<string, unknown>>) : [];
      return actions.map((action) => {
        const callId = typeof action.callId === "string" ? action.callId : null;
        const name = [action.toolName, action.name, action.skillName, action.kind].find((v) => typeof v === "string") as string;
        return row(
          "tool.started",
          { toolName: name ?? null, toolCallId: callId, data: { kind: action.kind ?? null, input: redactInput(action.input ?? {}) } },
          `:${callId ?? name}`,
        );
      });
    }
    case "action.result": {
      const result = (data.result ?? {}) as Record<string, unknown>;
      const callId = typeof result.callId === "string" ? result.callId : null;
      const failed = data.status === "failed" || result.isError === true;
      const code = failed ? ((data.error as { code?: string } | undefined)?.code ?? "FAILED") : errorCode(result.output);
      const status = data.status === "rejected" ? "rejected" : failed || code ? "error" : "ok";
      let durationMs: number | null = null;
      if (callId) {
        const [started] = await db()
          .select({ at: conversationEvents.createdAt })
          .from(conversationEvents)
          .where(and(eq(conversationEvents.orgId, base.orgId), eq(conversationEvents.toolCallId, callId), eq(conversationEvents.kind, "tool.started")))
          .limit(1);
        if (started) durationMs = Math.max(0, new Date(event.meta.at).getTime() - started.at.getTime());
      }
      const name = [result.toolName, result.name, result.kind].find((v) => typeof v === "string") as string | undefined;
      return [row("tool.completed", { toolName: name ?? null, toolCallId: callId, status, durationMs, data: code ? { error: code } : {} })];
    }
    case "turn.completed":
      return [row(event.type, { status: "completed" })];
    case "turn.cancelled":
      return [row(event.type, { status: "cancelled" })];
    case "turn.failed":
      return [
        row(event.type, {
          status: "failed",
          data: { code: typeof data.code === "string" ? data.code : null, message: truncate(String(data.message ?? ""), 200) },
        }),
      ];
    default:
      return [];
  }
}

/** The kinds `persistEvent` keeps; everything else is skipped before any lookup. */
const KEPT = new Set([
  "turn.started",
  "message.received",
  "message.completed",
  "actions.requested",
  "action.result",
  ...TERMINAL,
]);

/**
 * Records one eve stream event for the conversation its session belongs to. Never throws: a hook
 * failure only loses the record. Subagent sessions and turns without a member (the schedule's,
 * local dev's owner fallback) are skipped.
 */
export async function persistEvent(
  event: StreamEvent,
  session: { id: string; auth: TurnAuth; parent?: unknown },
): Promise<{ recorded: number }> {
  if (!KEPT.has(event.type) || session.parent) return { recorded: 0 };
  try {
    const found = await conversationForSession(session.auth, session.id);
    if (!found) return { recorded: 0 };
    const rows = await rowsFor(event, {
      orgId: found.orgId,
      conversationId: found.conversationId,
      memberId: found.memberId,
      eveSessionId: session.id,
      deliveryId: attr(session.auth, "deliveryId"),
      createdAt: new Date(event.meta.at),
      data: {},
    });
    if (rows.length === 0) return { recorded: 0 };
    for (const row of rows) row.data = { ...(row.data ?? {}), origin: originOf(session.auth) };
    const inserted = await db().insert(conversationEvents).values(rows).onConflictDoNothing().returning({ id: conversationEvents.id });
    return { recorded: inserted.length };
  } catch (error) {
    console.error("conversation events: not recorded", { type: event.type, eveSessionId: session.id, error });
    return { recorded: 0 };
  }
}

export type ActivityRow = {
  id: string;
  at: string;
  kind: string;
  memberId: string | null;
  memberName: string | null;
  conversationId: string;
  conversationKind: string;
  conversationTitle: string | null;
  turnId: string | null;
  toolName: string | null;
  status: string | null;
  durationMs: number | null;
  origin: string | null;
  text: string | null;
  error: string | null;
};

/**
 * A business's recent conversation events, newest first, with who and which conversation. Optionally
 * one member or conversation, and before a time for the next page. Scoped to `orgId`.
 */
export async function activityFor(
  orgId: string,
  options: { limit?: number; before?: Date; memberId?: string; conversationId?: string } = {},
): Promise<ActivityRow[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const rows = await db()
    .select({
      event: conversationEvents,
      memberName: members.name,
      conversationKind: conversations.kind,
      conversationTitle: conversations.title,
    })
    .from(conversationEvents)
    .innerJoin(conversations, and(eq(conversations.orgId, conversationEvents.orgId), eq(conversations.id, conversationEvents.conversationId)))
    .leftJoin(members, and(eq(members.orgId, conversationEvents.orgId), eq(members.id, conversationEvents.memberId)))
    .where(
      and(
        eq(conversationEvents.orgId, orgId),
        options.before ? lt(conversationEvents.createdAt, options.before) : undefined,
        options.memberId ? eq(conversationEvents.memberId, options.memberId) : undefined,
        options.conversationId ? eq(conversationEvents.conversationId, options.conversationId) : undefined,
      ),
    )
    .orderBy(desc(conversationEvents.createdAt), desc(conversationEvents.id))
    .limit(limit);
  return rows.map(({ event, memberName, conversationKind, conversationTitle }) => {
    const data = event.data ?? {};
    return {
      id: event.id,
      at: event.createdAt.toISOString(),
      kind: event.kind,
      memberId: event.memberId,
      memberName: memberName ?? null,
      conversationId: event.conversationId,
      conversationKind,
      conversationTitle,
      turnId: event.turnId,
      toolName: event.toolName,
      status: event.status,
      durationMs: event.durationMs,
      origin: typeof data.origin === "string" ? data.origin : null,
      text: typeof data.text === "string" ? data.text : null,
      error: typeof data.error === "string" ? data.error : typeof data.code === "string" ? data.code : null,
    };
  });
}

/** True once eve has started the turn for this inbound text (its turn's events carry the delivery). */
export async function deliveryReachedEve(orgId: string, deliveryId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.orgId, orgId), eq(conversationEvents.deliveryId, deliveryId)))
    .limit(1);
  return Boolean(row);
}

/**
 * True while a turn in the member's thread has started in the last `withinMs` and not ended: a text
 * handed over behind it is still queued in eve, not lost.
 */
export async function threadTurnRunning(orgId: string, memberId: string, now: Date, withinMs = 15 * 60_000): Promise<boolean> {
  const [latest] = await db()
    .select({ kind: conversationEvents.kind, at: conversationEvents.createdAt })
    .from(conversationEvents)
    .innerJoin(conversations, and(eq(conversations.orgId, conversationEvents.orgId), eq(conversations.id, conversationEvents.conversationId)))
    .where(
      and(
        eq(conversationEvents.orgId, orgId),
        eq(conversationEvents.memberId, memberId),
        eq(conversations.kind, "thread"),
        inArray(conversationEvents.kind, ["turn.started", ...TERMINAL]),
        gte(conversationEvents.createdAt, new Date(now.getTime() - withinMs)),
      ),
    )
    .orderBy(desc(conversationEvents.createdAt), desc(conversationEvents.id))
    .limit(1);
  return latest?.kind === "turn.started";
}

/** Deletes events older than the retention window, across businesses (the hourly tick's sweep). */
export async function pruneConversationEvents(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60_000);
  const deleted = await db().delete(conversationEvents).where(lt(conversationEvents.createdAt, cutoff)).returning({ id: conversationEvents.id });
  return deleted.length;
}

/** Counts by kind for one business since `since`: the Activity page's summary line. */
export async function activitySummary(orgId: string, since: Date): Promise<{ turns: number; failed: number; tools: number; toolErrors: number }> {
  const [row] = await db()
    .select({
      turns: sql<number>`count(*) filter (where ${conversationEvents.kind} = 'turn.started')::int`,
      failed: sql<number>`count(*) filter (where ${conversationEvents.kind} = 'turn.failed')::int`,
      tools: sql<number>`count(*) filter (where ${conversationEvents.kind} = 'tool.completed')::int`,
      toolErrors: sql<number>`count(*) filter (where ${conversationEvents.kind} = 'tool.completed' and ${conversationEvents.status} = 'error')::int`,
    })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.orgId, orgId), gte(conversationEvents.createdAt, since)));
  return row ?? { turns: 0, failed: 0, tools: 0, toolErrors: 0 };
}

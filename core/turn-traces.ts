// What the assistant did in each turn, as eve ran it: `agents/assistant/agent/hooks/trace.ts` hands
// every stream event here, and each turn becomes one `turn_traces` row whose steps are appended as
// the events arrive. The web chat's "Under the hood" reads a turn's model and tokens from it, and
// `scripts/export-traces.ts` writes the rows out as JSONL.
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { turnTraces } from "../schema/schema";
import type { TraceStep, TraceUsage } from "../schema/types";
import { activeVertical } from "../verticals";
import { instructionsHash, readAgentInstructions } from "./agent-instructions";
import { originOf, RETENTION_DAYS, type StreamEvent, type TurnAuth } from "./conversation-events";
import { db, newId } from "./db";
import { resolveCaller } from "./members";
import { attributionFor } from "./usage";

export type TurnTrace = typeof turnTraces.$inferSelect;

/** The most of one input, output, or text a step keeps, in characters of JSON. */
export const STEP_LIMIT = 32 * 1024;
const USAGE_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const;
const TERMINAL: Record<string, string> = { "turn.completed": "completed", "turn.failed": "failed", "turn.cancelled": "cancelled" };

/** The kinds a trace keeps; everything else is skipped before any lookup. */
const KEPT = new Set([
  "turn.started",
  "message.received",
  "step.started",
  "actions.requested",
  "action.result",
  "reasoning.completed",
  "message.completed",
  "step.completed",
  ...Object.keys(TERMINAL),
]);

/** A value as a step stores it: whole when its JSON fits the limit, else that JSON cut to the limit. */
export function capped(value: unknown): { value: unknown; truncated: boolean } {
  const json = JSON.stringify(value);
  if (json === undefined || json.length <= STEP_LIMIT) return { value, truncated: false };
  return { value: json.slice(0, STEP_LIMIT), truncated: true };
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** A step's token and cost counts, only the numeric ones. */
function usageOf(value: unknown): TraceUsage | null {
  if (!value || typeof value !== "object") return null;
  const out: Record<string, number> = {};
  for (const key of USAGE_KEYS) {
    const n = (value as Record<string, unknown>)[key];
    if (typeof n === "number" && Number.isFinite(n)) out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

type Change = { steps: TraceStep[]; modelId?: string; usage?: TraceUsage; status?: string; finishedAt?: Date };

/** What one stream event changes on its turn's trace. */
function changeFor(event: StreamEvent, data: Record<string, unknown>): Change {
  const base = { eventId: event.meta.id, at: event.meta.at, stepIndex: typeof data.stepIndex === "number" ? data.stepIndex : null };
  switch (event.type) {
    case "message.received": {
      // The member's words, and their files by name and type only.
      const body = capped(text(data.message) ?? "");
      const parts = Array.isArray(data.parts) ? (data.parts as Array<Record<string, unknown>>) : [];
      const files = parts.filter((part) => part?.type === "file").map((part) => ({ name: text(part.filename) ?? null, mediaType: text(part.mediaType) ?? null }));
      return {
        steps: [
          {
            ...base,
            kind: "input",
            text: body.value as string,
            ...(files.length ? { files } : {}),
            ...(body.truncated ? { truncated: true } : {}),
          },
        ],
      };
    }
    case "step.started": {
      // Eve reports the model as `<provider>/<id>`; the trace keeps the bare id.
      const modelId = text(data.modelId)?.replace(/^[a-z0-9-]+\//, "");
      return { steps: [{ ...base, kind: "step", status: "started", modelId }], modelId };
    }
    case "actions.requested": {
      const actions = Array.isArray(data.actions) ? (data.actions as Array<Record<string, unknown>>) : [];
      return {
        steps: actions.map((action) => {
          const input = capped(action.input ?? {});
          const name = [action.toolName, action.name, action.skillName, action.kind].find((v) => typeof v === "string") as string | undefined;
          return {
            ...base,
            kind: "tool.call",
            toolName: name,
            callId: text(action.callId),
            input: input.value,
            ...(input.truncated ? { truncated: true } : {}),
          };
        }),
      };
    }
    case "action.result": {
      const result = (data.result ?? {}) as Record<string, unknown>;
      const output = capped(result.output ?? data.error ?? null);
      const name = [result.toolName, result.name, result.kind].find((v) => typeof v === "string") as string | undefined;
      return {
        steps: [
          {
            ...base,
            kind: "tool.result",
            toolName: name,
            callId: text(result.callId),
            output: output.value,
            isError: data.status === "failed" || result.isError === true,
            status: text(data.status),
            ...(output.truncated ? { truncated: true } : {}),
          },
        ],
      };
    }
    case "reasoning.completed":
    case "message.completed": {
      const body = capped(text(event.type === "reasoning.completed" ? data.reasoning : data.message) ?? "");
      return {
        steps: [
          {
            ...base,
            kind: event.type === "reasoning.completed" ? "reasoning" : "message",
            text: body.value as string,
            finishReason: text(data.finishReason),
            ...(body.truncated ? { truncated: true } : {}),
          },
        ],
      };
    }
    case "step.completed": {
      const usage = usageOf(data.usage) ?? undefined;
      return { steps: [{ ...base, kind: "step", status: "completed", finishReason: text(data.finishReason), usage }], usage };
    }
    default:
      return { steps: [], status: TERMINAL[event.type], finishedAt: new Date(event.meta.at) };
  }
}

/** The business a turn runs for: the one on its auth, or local dev's owner fallback. */
async function orgOf(auth: TurnAuth): Promise<string | null> {
  const named = auth?.attributes?.orgId;
  if (typeof named === "string" && named) return named;
  if (!auth) return null;
  const caller = await resolveCaller({ ...auth, attributes: auth.attributes ?? {} }).catch(() => null);
  return caller?.orgId ?? null;
}

/** What the turn starts with: the hash of its instructions (null when they can't be read) and the pack. */
function startedWith(): { instructionsHash: string | null; vertical: string | null } {
  const pack = activeVertical();
  const instructions = readAgentInstructions();
  return { instructionsHash: instructions ? instructionsHash(instructions, pack?.instructions ?? null) : null, vertical: pack?.id ?? null };
}

/** Adds a turn's row if it isn't there yet. A late `turn.started` moves `started_at` back to it. */
async function ensureTrace(session: { id: string; auth: TurnAuth }, turnId: string, at: string): Promise<boolean> {
  const who = await attributionFor({ auth: session.auth, eveSessionId: session.id, turnId, stepIndex: null });
  if (!who) return false;
  await db()
    .insert(turnTraces)
    .values({
      id: newId("trc"),
      orgId: who.orgId,
      conversationId: who.conversationId,
      memberId: who.memberId,
      eveSessionId: session.id,
      turnId,
      source: originOf(session.auth),
      ...startedWith(),
      startedAt: new Date(at),
    })
    .onConflictDoUpdate({
      target: [turnTraces.orgId, turnTraces.eveSessionId, turnTraces.turnId],
      set: { startedAt: sql`least(${turnTraces.startedAt}, excluded.started_at)` },
    });
  return true;
}

/**
 * Applies one event's change in a single update: appends its steps, unless a step from the same event
 * is already there, and sets the model, adds the usage, and ends the turn. False when nothing matched:
 * no row yet, or the event was already applied.
 */
async function apply(orgId: string, eveSessionId: string, turnId: string, eventId: string, change: Change): Promise<boolean> {
  const usage = change.usage ? JSON.stringify(change.usage) : null;
  const updated = await db()
    .update(turnTraces)
    .set({
      steps: sql`${turnTraces.steps} || ${JSON.stringify(change.steps)}::jsonb`,
      ...(change.modelId ? { modelId: change.modelId } : {}),
      ...(usage
        ? {
            usage: sql`(select jsonb_object_agg(k, coalesce((${turnTraces.usage} ->> k)::numeric, 0) + coalesce((${usage}::jsonb ->> k)::numeric, 0))
              from jsonb_object_keys(coalesce(${turnTraces.usage}, '{}'::jsonb) || ${usage}::jsonb) as k)`,
          }
        : {}),
      ...(change.status ? { status: change.status, finishedAt: change.finishedAt } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(turnTraces.orgId, orgId),
        eq(turnTraces.eveSessionId, eveSessionId),
        eq(turnTraces.turnId, turnId),
        sql`not ${turnTraces.steps} @> ${JSON.stringify([{ eventId }])}::jsonb`,
      ),
    )
    .returning({ id: turnTraces.id });
  return updated.length > 0;
}

/**
 * Records one eve stream event on its turn's trace. Never throws: a hook failure only loses the
 * record. Subagent sessions and turns with no business are skipped. A session with no conversation
 * (an eval's) is still traced, with a null `conversation_id`.
 */
export async function recordTraceEvent(event: StreamEvent, session: { id: string; auth: TurnAuth; parent?: unknown }): Promise<void> {
  if (!KEPT.has(event.type) || session.parent) return;
  const data = (event.data ?? {}) as Record<string, unknown>;
  const turnId = text(data.turnId);
  if (!turnId) return;
  try {
    if (event.type === "turn.started") {
      await ensureTrace(session, turnId, event.meta.at);
      return;
    }
    const orgId = await orgOf(session.auth);
    if (!orgId) return;
    const change = changeFor(event, data);
    if (await apply(orgId, session.id, turnId, event.meta.id, change)) return;
    // No row yet (the turn's start was missed), or the event was already applied: add the row and try once more.
    if (await ensureTrace(session, turnId, event.meta.at)) await apply(orgId, session.id, turnId, event.meta.id, change);
  } catch (error) {
    // The error's name and database code only: a failed query's message carries its parameters, the step's inputs and outputs.
    const code = (error as { cause?: { code?: unknown }; code?: unknown } | null)?.cause?.code ?? (error as { code?: unknown } | null)?.code;
    console.error("turn traces: not recorded", { type: event.type, eveSessionId: session.id, error: error instanceof Error ? error.name : "error", code });
  }
}

/** One turn's trace, scoped to `orgId`, or null. */
export async function traceFor(orgId: string, eveSessionId: string, turnId: string): Promise<TurnTrace | null> {
  const [row] = await db()
    .select()
    .from(turnTraces)
    .where(and(eq(turnTraces.orgId, orgId), eq(turnTraces.eveSessionId, eveSessionId), eq(turnTraces.turnId, turnId)))
    .limit(1);
  return row ?? null;
}

/** A business's traces, newest first: optionally one conversation's, or those started since a time. */
export async function listTraces(orgId: string, opts: { conversationId?: string; since?: Date; limit?: number } = {}): Promise<TurnTrace[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 10_000));
  return db()
    .select()
    .from(turnTraces)
    .where(
      and(
        eq(turnTraces.orgId, orgId),
        opts.conversationId ? eq(turnTraces.conversationId, opts.conversationId) : undefined,
        opts.since ? gte(turnTraces.startedAt, opts.since) : undefined,
      ),
    )
    .orderBy(desc(turnTraces.startedAt), desc(turnTraces.id))
    .limit(limit);
}

/** Deletes traces older than the conversation events' retention window, across businesses (the hourly tick's sweep). */
export async function pruneTurnTraces(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60_000);
  const deleted = await db().delete(turnTraces).where(lt(turnTraces.startedAt, cutoff)).returning({ id: turnTraces.id });
  return deleted.length;
}

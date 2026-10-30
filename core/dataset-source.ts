// What the training export reads from the database for one business (core/dataset.ts builds from it):
// its turn traces, the records their labels come from, and, for a trace from before turns kept the
// member's message, that message from the conversation's events. Every query is scoped by `orgId`.
import { and, eq, inArray } from "drizzle-orm";
import { conversationEvents, quoteRevisions, quotes } from "../schema/schema";
import type { TraceStep } from "../schema/types";
import { quotesTouched, type QuoteFacts, type TraceInput, type TurnRecords } from "./dataset";
import { db } from "./db";
import { listTraces } from "./turn-traces";

/** The records a set of traces' labels come from: each quote they name, its status, approval, and revisions. */
export async function recordsFor(orgId: string, traces: TraceInput[]): Promise<TurnRecords> {
  const ids = [...new Set(traces.flatMap((trace) => quotesTouched(trace.steps)))];
  if (!ids.length) return { quotes: [] };
  const rows = await db()
    .select({ id: quotes.id, status: quotes.status, approvedAt: quotes.approvedAt })
    .from(quotes)
    .where(and(eq(quotes.orgId, orgId), inArray(quotes.id, ids)));
  const revisions = await db()
    .select({ quoteId: quoteRevisions.quoteId, createdAt: quoteRevisions.createdAt })
    .from(quoteRevisions)
    .where(and(eq(quoteRevisions.orgId, orgId), inArray(quoteRevisions.quoteId, ids)));
  return {
    quotes: rows.map(
      (row): QuoteFacts => ({
        quoteId: row.id,
        status: row.status,
        approvedAt: row.approvedAt,
        revisionTimes: revisions.filter((r) => r.quoteId === row.id).map((r) => r.createdAt),
      }),
    ),
  };
}

/**
 * Traces with the member's message filled in where the trace lacks it, from the conversation's
 * `message.received` event (cut to 500 characters there). A trace with neither stays as it is.
 */
export async function withInputs(orgId: string, traces: TraceInput[]): Promise<TraceInput[]> {
  const missing = traces.filter((trace) => !trace.steps.some((step) => step.kind === "input"));
  if (!missing.length) return traces;
  const rows = await db()
    .select({ eveSessionId: conversationEvents.eveSessionId, turnId: conversationEvents.turnId, data: conversationEvents.data, createdAt: conversationEvents.createdAt })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.orgId, orgId),
        eq(conversationEvents.kind, "message.received"),
        inArray(conversationEvents.turnId, missing.map((trace) => trace.turnId)),
      ),
    );
  return traces.map((trace) => {
    if (!missing.includes(trace)) return trace;
    const row = rows.find((r) => r.eveSessionId === trace.eveSessionId && r.turnId === trace.turnId);
    const text = typeof row?.data?.text === "string" ? row.data.text : null;
    if (text === null) return trace;
    const input: TraceStep = { eventId: `input:${trace.turnId}`, at: (row?.createdAt ?? trace.startedAt).toISOString(), stepIndex: null, kind: "input", text };
    return { ...trace, steps: [input, ...trace.steps] };
  });
}

/** A business's traces for the export, oldest first, with their members' messages and the records to label them. */
export async function datasetSource(orgId: string, opts: { since?: Date } = {}): Promise<{ traces: TraceInput[]; records: TurnRecords }> {
  const traces = await withInputs(orgId, (await listTraces(orgId, { since: opts.since, limit: 10_000 })).reverse());
  return { traces, records: await recordsFor(orgId, traces) };
}

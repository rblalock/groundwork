import { and, eq, gte, sql } from "drizzle-orm";
import { events } from "../schema/schema";
import { db } from "./db";
import { recordEvent } from "./events";

// Some changes can't be taken back by text: merging two customers, archiving one. The assistant asks
// first, and the code holds it to that: the first call only records that it asked, and the change is
// made only by a call in a later turn of the same conversation, after the member has answered.

/** How long an asked question stays open. */
export const CONFIRM_WINDOW_MS = 30 * 60 * 1000;

export type ConfirmTurn = { sessionId: string; turnSequence: number };

/** The eve turn a tool call runs in, from its context. Null outside a turn (a test calling a tool directly). */
export function confirmTurn(ctx: { session: { id: string; turn?: { sequence: number } | null } }): ConfirmTurn | null {
  const sequence = ctx.session.turn?.sequence;
  return typeof sequence === "number" ? { sessionId: ctx.session.id, turnSequence: sequence } : null;
}

/**
 * True when this member was already asked about `action` on `subject` in an earlier turn of this
 * conversation, within the half hour: the change may go ahead. Otherwise records that they are being
 * asked now and returns false, so the tool sends the question instead.
 */
export async function confirmedEarlier(
  input: { orgId: string; memberId: string; action: string; subject: string; turn: ConfirmTurn | null },
  now: Date = new Date(),
): Promise<boolean> {
  const { turn } = input;
  if (!turn) return false;
  const [asked] = await db()
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.orgId, input.orgId),
        eq(events.kind, "confirm.asked"),
        eq(events.memberId, input.memberId),
        eq(events.refId, input.subject),
        sql`${events.data}->>'action' = ${input.action}`,
        sql`${events.data}->>'sessionId' = ${turn.sessionId}`,
        sql`(${events.data}->>'turnSequence')::int < ${turn.turnSequence}`,
        gte(events.createdAt, new Date(now.getTime() - CONFIRM_WINDOW_MS)),
      ),
    )
    .limit(1);
  if (asked) return true;
  await recordEvent({
    orgId: input.orgId,
    kind: "confirm.asked",
    // One question per action, subject, and turn.
    key: `confirm:${turn.sessionId}:${turn.turnSequence}:${input.action}:${input.subject}`,
    refId: input.subject,
    memberId: input.memberId,
    data: { action: input.action, sessionId: turn.sessionId, turnSequence: turn.turnSequence },
  });
  return false;
}

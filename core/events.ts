import { events } from "../schema/schema";
import { db, newId, type Db, type Tx } from "./db";

/**
 * Append to the business's event log. With a `key`, the insert is idempotent: a repeat of
 * the same key in the same business does nothing and returns `inserted: false`.
 */
export async function recordEvent(
  input: {
    orgId: string;
    kind: string;
    key?: string;
    refId?: string;
    memberId?: string;
    data?: Record<string, unknown>;
  },
  executor: Db | Tx = db(),
): Promise<{ inserted: boolean }> {
  const rows = await executor
    .insert(events)
    .values({
      id: newId("ev"),
      orgId: input.orgId,
      kind: input.kind,
      key: input.key ?? null,
      refId: input.refId ?? null,
      memberId: input.memberId ?? null,
      data: input.data ?? {},
    })
    .onConflictDoNothing({ target: [events.orgId, events.key] })
    .returning({ id: events.id });
  return { inserted: rows.length > 0 };
}

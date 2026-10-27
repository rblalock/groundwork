// The inbound text queue. The Photon webhook stores each delivery here before it answers Photon
// (core/photon-inbound.ts), then a worker handles it: right after the webhook answers, and again
// from the every-minute backstop (agents/assistant/agent/schedules/texts.ts) for anything a stopped instance left. One
// member's deliveries run one at a time, oldest first, under a lease; a failed try waits and retries,
// and after the last one the delivery is `dead`: logged, and nobody is texted.
import { and, asc, desc, eq, gte, inArray, lt, lte, ne, or, sql } from "drizzle-orm";
import { deliveries } from "../schema/schema";
import type { DeliveryProgress } from "../schema/types";
import { db, newId } from "./db";

export type Delivery = typeof deliveries.$inferSelect;

/** Tries before a delivery is dead. */
export const MAX_ATTEMPTS = 5;
/** How long a worker holds a delivery. One still `processing` after this is taken to be stalled. */
export const LEASE_MS = 3 * 60_000;
/** The wait after the first, second, third, and fourth failed tries. */
export const BACKOFF_MS = [10_000, 30_000, 2 * 60_000, 5 * 60_000] as const;
/** Done and dead deliveries are deleted after this many days. */
export const DELIVERY_RETENTION_DAYS = 30;

/**
 * Stores one verified inbound delivery. A second delivery with the same provider id (Photon delivers at
 * least once) stores nothing and returns the first one's id. Provider ids are unique across businesses,
 * so the duplicate's lookup needs no org: it is one of the ways an inbound text finds its business.
 */
export async function recordDelivery(input: {
  orgId: string;
  memberId: string;
  providerMessageId: string;
  webhookId?: string | null;
  kind: "message" | "reaction" | "email";
  threadId: string;
  payload: Record<string, unknown>;
  sentAt?: Date;
  now?: Date;
}): Promise<{ id: string; duplicate: boolean }> {
  const now = input.now ?? new Date();
  const [row] = await db()
    .insert(deliveries)
    .values({
      id: newId("dlv"),
      orgId: input.orgId,
      memberId: input.memberId,
      providerMessageId: input.providerMessageId,
      webhookId: input.webhookId ?? null,
      kind: input.kind,
      threadId: input.threadId,
      payload: input.payload,
      sentAt: input.sentAt ?? now,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: deliveries.providerMessageId })
    .returning({ id: deliveries.id });
  if (row) return { id: row.id, duplicate: false };
  const [existing] = await db()
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(eq(deliveries.providerMessageId, input.providerMessageId));
  return { id: existing.id, duplicate: true };
}

/** What handling one delivery came to: finished, or to look at again later (it isn't counted as a try). */
export type DeliveryResult = { kind: "done"; outcome: string } | { kind: "later"; at: Date; reason: string };

/** Lets a handler record what it has done so far, so a retry after a crash skips it. */
export interface DeliveryStep {
  readonly progress: DeliveryProgress;
  save(patch: Partial<DeliveryProgress>): Promise<void>;
}

export type DeliveryHandler = (delivery: Delivery, step: DeliveryStep) => Promise<DeliveryResult>;

const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);

/**
 * Leases the member's next delivery, or null when there's nothing to do now: none waiting, the oldest
 * still held by a live lease, or the oldest waiting out its backoff (later ones wait behind it, so a
 * member's texts reach eve in the order they were sent). A delivery whose lease ran out is stalled: it
 * is taken again, or dead if that was its last try. Serialized per member by an advisory lock.
 */
export async function claimNext(orgId: string, memberId: string, now: Date = new Date()): Promise<Delivery | null> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`deliveries:${orgId}:${memberId}`}))`);
    for (;;) {
      const [head] = await tx
        .select()
        .from(deliveries)
        .where(and(eq(deliveries.orgId, orgId), eq(deliveries.memberId, memberId), inArray(deliveries.status, ["pending", "processing"])))
        .orderBy(asc(deliveries.sentAt), asc(deliveries.createdAt), asc(deliveries.id))
        .limit(1);
      if (!head) return null;
      if (head.status === "processing" && head.leaseUntil && head.leaseUntil > now) return null;
      if (head.status === "pending" && head.nextAttemptAt > now) return null;
      if (head.status === "processing" && head.attempts >= MAX_ATTEMPTS) {
        await tx
          .update(deliveries)
          .set({ status: "dead", leaseUntil: null, lastError: head.lastError ?? "stalled: the last try never finished", updatedAt: now })
          .where(and(eq(deliveries.orgId, orgId), eq(deliveries.id, head.id)));
        deadLetter(head, "stalled on its last try");
        continue;
      }
      if (head.status === "processing") {
        console.warn("deliveries: a stalled delivery is taken again", { deliveryId: head.id, orgId, attempts: head.attempts });
      }
      const [claimed] = await tx
        .update(deliveries)
        .set({ status: "processing", attempts: head.attempts + 1, leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now })
        .where(and(eq(deliveries.orgId, orgId), eq(deliveries.id, head.id)))
        .returning();
      return claimed;
    }
  });
}

function deadLetter(delivery: Pick<Delivery, "id" | "orgId" | "memberId" | "providerMessageId" | "attempts">, why: string): void {
  // Nobody is texted: the member already heard nothing back or got the failure line from eve, and the
  // owner can't act on it. This line is what to search the logs for.
  console.error("deliveries: dead-lettered an inbound text", {
    deliveryId: delivery.id,
    orgId: delivery.orgId,
    memberId: delivery.memberId,
    providerMessageId: delivery.providerMessageId,
    attempts: delivery.attempts,
    why,
  });
}

/** Writes a try's result, but only while this try still holds the delivery (same status and attempt). */
async function settle(delivery: Delivery, result: DeliveryResult | { kind: "error"; error: unknown }, now: Date): Promise<{ dead: boolean }> {
  const mine = and(
    eq(deliveries.orgId, delivery.orgId),
    eq(deliveries.id, delivery.id),
    eq(deliveries.status, "processing"),
    eq(deliveries.attempts, delivery.attempts),
  );
  if (result.kind === "done") {
    await db().update(deliveries).set({ status: "done", outcome: result.outcome, leaseUntil: null, updatedAt: now }).where(mine);
    return { dead: false };
  }
  if (result.kind === "later") {
    await db()
      .update(deliveries)
      .set({ status: "pending", attempts: delivery.attempts - 1, nextAttemptAt: result.at, leaseUntil: null, outcome: result.reason, updatedAt: now })
      .where(mine);
    return { dead: false };
  }
  const lastError = describe(result.error);
  if (delivery.attempts >= MAX_ATTEMPTS) {
    await db().update(deliveries).set({ status: "dead", lastError, leaseUntil: null, updatedAt: now }).where(mine);
    deadLetter(delivery, lastError);
    return { dead: true };
  }
  const wait = BACKOFF_MS[Math.min(delivery.attempts, BACKOFF_MS.length) - 1];
  console.warn("deliveries: an inbound text failed and will be retried", {
    deliveryId: delivery.id,
    orgId: delivery.orgId,
    attempts: delivery.attempts,
    retryInMs: wait,
    error: lastError,
  });
  await db()
    .update(deliveries)
    .set({ status: "pending", lastError, nextAttemptAt: new Date(now.getTime() + wait), leaseUntil: null, updatedAt: now })
    .where(mine);
  return { dead: false };
}

function stepFor(delivery: Delivery): DeliveryStep {
  const progress: DeliveryProgress = { ...delivery.progress };
  return {
    progress,
    async save(patch) {
      Object.assign(progress, patch);
      await db()
        .update(deliveries)
        .set({ progress: { ...progress }, updatedAt: new Date() })
        .where(and(eq(deliveries.orgId, delivery.orgId), eq(deliveries.id, delivery.id)));
    },
  };
}

/** Handles one leased delivery and records how it went. Never throws. */
export async function processDelivery(
  delivery: Delivery,
  handler: DeliveryHandler,
  clock: () => Date = () => new Date(),
): Promise<DeliveryResult | { kind: "error"; dead: boolean }> {
  let result: DeliveryResult;
  try {
    result = await handler(delivery, stepFor(delivery));
  } catch (error) {
    const settled = await settle(delivery, { kind: "error", error }, clock()).catch((settleError) => {
      console.error("deliveries: a failed try could not be recorded; its lease will run out", { deliveryId: delivery.id, settleError });
      return { dead: false };
    });
    return { kind: "error", dead: settled.dead };
  }
  await settle(delivery, result, clock());
  return result;
}

/**
 * Works through one member's deliveries in order until none is ready (or `max` have run). The claim
 * makes concurrent workers safe: a second worker on the same member finds the lease and stops.
 */
export async function processMember(
  orgId: string,
  memberId: string,
  handler: DeliveryHandler,
  options: { clock?: () => Date; max?: number } = {},
): Promise<number> {
  const clock = options.clock ?? (() => new Date());
  let handled = 0;
  while (handled < (options.max ?? 25)) {
    const delivery = await claimNext(orgId, memberId, clock());
    if (!delivery) break;
    handled += 1;
    const result = await processDelivery(delivery, handler, clock);
    // A wait or a retry holds the member's later texts behind it; a dead one no longer does.
    if (result.kind === "later" || (result.kind === "error" && !result.dead)) break;
  }
  return handled;
}

/**
 * The members with a delivery ready now: pending and due, or stalled. Reads across businesses on
 * purpose, like the hourly tick: it is the backstop's sweep, and each member's work then runs in its
 * own business.
 */
export async function readyMembers(now: Date = new Date(), limit = 50): Promise<Array<{ orgId: string; memberId: string }>> {
  const rows = await db()
    .selectDistinct({ orgId: deliveries.orgId, memberId: deliveries.memberId })
    .from(deliveries)
    .where(
      or(
        and(eq(deliveries.status, "pending"), lte(deliveries.nextAttemptAt, now)),
        and(eq(deliveries.status, "processing"), lt(deliveries.leaseUntil, now)),
      ),
    )
    .limit(limit);
  return rows;
}

/** Drains every ready member, three at a time. Returns how many members and deliveries it handled. */
export async function drainDeliveries(handler: DeliveryHandler, options: { clock?: () => Date } = {}): Promise<{ members: number; handled: number }> {
  const clock = options.clock ?? (() => new Date());
  const ready = await readyMembers(clock());
  let handled = 0;
  for (let i = 0; i < ready.length; i += 3) {
    const counts = await Promise.all(
      ready.slice(i, i + 3).map(({ orgId, memberId }) =>
        processMember(orgId, memberId, handler, { clock }).catch((error) => {
          console.error("deliveries: a member's queue could not be drained", { orgId, memberId, error });
          return 0;
        }),
      ),
    );
    handled += counts.reduce((a, b) => a + b, 0);
  }
  return { members: ready.length, handled };
}

/** Deletes finished deliveries past retention, across businesses (the hourly sweep). */
export async function pruneDeliveries(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - DELIVERY_RETENTION_DAYS * 24 * 60 * 60_000);
  const deleted = await db()
    .delete(deliveries)
    .where(and(inArray(deliveries.status, ["done", "dead"]), lt(deliveries.updatedAt, cutoff)))
    .returning({ id: deliveries.id });
  return deleted.length;
}

/**
 * The member's latest delivery before this one that was handed to eve in the last ten minutes, if any:
 * the turn the next text should wait behind.
 */
export async function previousHandOff(delivery: Pick<Delivery, "id" | "orgId" | "memberId" | "sentAt">, now: Date): Promise<Delivery | null> {
  const [row] = await db()
    .select()
    .from(deliveries)
    .where(
      and(
        eq(deliveries.orgId, delivery.orgId),
        eq(deliveries.memberId, delivery.memberId),
        ne(deliveries.id, delivery.id),
        eq(deliveries.status, "done"),
        eq(deliveries.outcome, "dispatch"),
        lte(deliveries.sentAt, delivery.sentAt),
        gte(deliveries.updatedAt, new Date(now.getTime() - 10 * 60_000)),
      ),
    )
    .orderBy(desc(deliveries.sentAt), desc(deliveries.createdAt))
    .limit(1);
  return row ?? null;
}

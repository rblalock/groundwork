// Per-business usage limits: a cap on turns and on model output tokens in any rolling hour, and on
// turns running at once. A turn is admitted before it starts, at each place one can: a text at the
// inbound queue's hand-off (core/photon-inbound.ts; over a limit, it stays queued), a web or job
// turn in eve's channel auth (lib/eve-auth.ts; over a limit, a 429). Admission reserves the turn
// (`turn_reservations`) and holds some output tokens for it, then eve's hooks mark it running and
// settled (agents/assistant/agent/hooks/usage.ts) while the metered model's receipts measure what it really used.
// A reservation nobody hears from for 15 minutes stops holding its slot. Super admins don't bypass
// limits: they raise them, per business, from the admin page. A translation in the web app
// (core/translation.ts) is a model call, not a turn: it's admitted against the output tokens
// only (`admitModelCall`), so reading a thread never uses up a business's turns or slots.
import { and, asc, eq, gt, inArray, lte, ne, notInArray, sql } from "drizzle-orm";
import { turnReservations, usageLimits, usageReceipts } from "../schema/schema";
import { db, newId, type Tx } from "./db";

export type UsageChannel = "text" | "email" | "web" | "job" | "schedule" | "local" | "translation" | "other";
export const USAGE_CHANNELS: readonly UsageChannel[] = ["text", "email", "web", "job", "schedule", "local", "translation", "other"];
/** Reservations on these channels hold output tokens but aren't turns: no turn count, no slot. */
const NOT_TURNS = ["translation"] as const;

export type Limits = { hourlyTurns: number; hourlyOutputTokens: number; concurrentTurns: number };
export type LimitOverrides = { [K in keyof Limits]: number | null };
export type LimitReason = "hourly_turns" | "hourly_output_tokens" | "concurrent_turns";

export const WINDOW_MS = 60 * 60_000;
/** A reservation not heard from (admitted, started, or a model call) for this long stops holding a slot. */
export const LEASE_MS = 15 * 60_000;

/** What each limit may be set to. */
export const LIMIT_BOUNDS: Readonly<Record<keyof Limits, { min: number; max: number }>> = {
  hourlyTurns: { min: 1, max: 10_000 },
  hourlyOutputTokens: { min: 1_000, max: 100_000_000 },
  concurrentTurns: { min: 1, max: 50 },
};

function envInt(name: string, fallback: number, bounds: { min: number; max: number }): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    console.error(`usage limits: ${name} must be an integer from ${bounds.min} to ${bounds.max}; using ${fallback}`);
    return fallback;
  }
  return value;
}

/**
 * The defaults, for a small business: a turn a minute, about 150k output tokens (roughly $1.80 at list
 * price) an hour, and three turns at once. Each is overridable for the whole app by environment and per
 * business by a super admin.
 */
export function defaultLimits(): Limits {
  return {
    hourlyTurns: envInt("USAGE_HOURLY_TURNS", 60, LIMIT_BOUNDS.hourlyTurns),
    hourlyOutputTokens: envInt("USAGE_HOURLY_OUTPUT_TOKENS", 150_000, LIMIT_BOUNDS.hourlyOutputTokens),
    concurrentTurns: envInt("USAGE_CONCURRENT_TURNS", 3, LIMIT_BOUNDS.concurrentTurns),
  };
}

/** Output tokens held for a turn until its receipts come in. */
export function turnOutputReserve(): number {
  return envInt("USAGE_TURN_OUTPUT_RESERVE", 8_000, { min: 0, max: 1_000_000 });
}

/** The business's limits: its own where a super admin set one, else the defaults. */
export async function limitsFor(orgId: string, executor: Tx | ReturnType<typeof db> = db()): Promise<{ limits: Limits; overrides: LimitOverrides }> {
  const [row] = await executor.select().from(usageLimits).where(eq(usageLimits.orgId, orgId));
  const overrides: LimitOverrides = {
    hourlyTurns: row?.hourlyTurns ?? null,
    hourlyOutputTokens: row?.hourlyOutputTokens ?? null,
    concurrentTurns: row?.concurrentTurns ?? null,
  };
  const defaults = defaultLimits();
  return {
    limits: {
      hourlyTurns: overrides.hourlyTurns ?? defaults.hourlyTurns,
      hourlyOutputTokens: overrides.hourlyOutputTokens ?? defaults.hourlyOutputTokens,
      concurrentTurns: overrides.concurrentTurns ?? defaults.concurrentTurns,
    },
    overrides,
  };
}

/**
 * Sets a business's limits; null puts one back to the default. Super admins only: the route checks
 * (`app/api/admin/businesses/[id]/usage-limits`). Throws `INVALID_LIMIT` for a value out of bounds.
 */
export async function setUsageLimits(orgId: string, patch: Partial<LimitOverrides>, updatedBy: string, now: Date = new Date()): Promise<LimitOverrides> {
  for (const [key, value] of Object.entries(patch) as Array<[keyof Limits, number | null | undefined]>) {
    if (!(key in LIMIT_BOUNDS)) throw new Error("INVALID_LIMIT");
    if (value === null || value === undefined) continue;
    const bounds = LIMIT_BOUNDS[key];
    if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) throw new Error("INVALID_LIMIT");
  }
  const { overrides: current } = await limitsFor(orgId);
  const next: LimitOverrides = { ...current, ...patch };
  await db()
    .insert(usageLimits)
    .values({ orgId, ...next, updatedBy, updatedAt: now })
    .onConflictDoUpdate({ target: usageLimits.orgId, set: { ...next, updatedBy, updatedAt: now } });
  return next;
}

const ACTIVE = ["reserved", "running"] as const;
/** Statuses that never ran as a turn of their own. */
const UNCOUNTED = ["released", "merged"] as const;

async function lockOrg(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`usage:${orgId}`}))`);
}

/** Lets go of reservations nobody has heard from within the lease. They still count as turns. */
async function expireStalled(tx: Tx, orgId: string, now: Date): Promise<number> {
  const expired = await tx
    .update(turnReservations)
    .set({ status: "expired", updatedAt: now })
    .where(and(eq(turnReservations.orgId, orgId), inArray(turnReservations.status, [...ACTIVE]), lte(turnReservations.leaseUntil, now)))
    .returning({ id: turnReservations.id });
  if (expired.length) console.warn("usage limits: stalled turn reservations released", { orgId, count: expired.length });
  return expired.length;
}

export type UsageWindow = {
  /** Turns admitted in the last hour. */
  turns: number;
  /** Output tokens measured in the last hour, plus what running and waiting turns still hold. */
  outputTokens: number;
  measuredOutputTokens: number;
  heldOutputTokens: number;
  /** Turns running or waiting to start. */
  active: number;
};

async function windowOf(tx: Tx, orgId: string, now: Date) {
  const since = new Date(now.getTime() - WINDOW_MS);
  const counted = await tx
    .select({ id: turnReservations.id, createdAt: turnReservations.createdAt })
    .from(turnReservations)
    .where(
      and(
        eq(turnReservations.orgId, orgId),
        gt(turnReservations.createdAt, since),
        notInArray(turnReservations.status, [...UNCOUNTED]),
        notInArray(turnReservations.channel, [...NOT_TURNS]),
      ),
    )
    .orderBy(asc(turnReservations.createdAt));
  const active = await tx
    .select({ id: turnReservations.id, reserved: turnReservations.reservedOutputTokens, channel: turnReservations.channel })
    .from(turnReservations)
    .where(and(eq(turnReservations.orgId, orgId), inArray(turnReservations.status, [...ACTIVE])));
  const receipts = await tx
    .select({ at: usageReceipts.createdAt, output: usageReceipts.outputTokens })
    .from(usageReceipts)
    .where(and(eq(usageReceipts.orgId, orgId), gt(usageReceipts.createdAt, since)))
    .orderBy(asc(usageReceipts.createdAt));
  const measuredByReservation = new Map<string, number>();
  if (active.length) {
    const rows = await tx
      .select({ id: usageReceipts.reservationId, output: sql<number>`coalesce(sum(${usageReceipts.outputTokens}), 0)::int` })
      .from(usageReceipts)
      .where(and(eq(usageReceipts.orgId, orgId), inArray(usageReceipts.reservationId, active.map((a) => a.id))))
      .groupBy(usageReceipts.reservationId);
    for (const row of rows) if (row.id) measuredByReservation.set(row.id, row.output);
  }
  const measured = receipts.reduce((sum, row) => sum + row.output, 0);
  const held = active.reduce((sum, row) => sum + Math.max(0, row.reserved - (measuredByReservation.get(row.id) ?? 0)), 0);
  return {
    counted,
    receipts,
    window: {
      turns: counted.length,
      outputTokens: measured + held,
      measuredOutputTokens: measured,
      heldOutputTokens: held,
      active: active.filter((row) => !(NOT_TURNS as readonly string[]).includes(row.channel)).length,
    } satisfies UsageWindow,
  };
}

export type Admission =
  | { ok: true; reservationId: string; duplicate: boolean }
  | { ok: false; reason: LimitReason; retryAt: Date; limits: Limits; window: UsageWindow };

/** When enough of the window's measured output leaves it to free `need` tokens (or in a minute, if it never does). */
function tokensFreeAt(receipts: Array<{ at: Date; output: number }>, need: number, now: Date): number {
  let freed = 0;
  for (const receipt of receipts) {
    freed += receipt.output;
    if (freed >= need) return receipt.at.getTime() + WINDOW_MS + 1_000;
  }
  return now.getTime() + 60_000;
}

const clampRetry = (at: number, now: Date) => new Date(Math.min(Math.max(at, now.getTime() + 15_000), now.getTime() + WINDOW_MS));

/**
 * Admits one turn for the business, or says which limit it's over and when to try again. One `key` is
 * one turn: a second admission with the key of a reservation still waiting or running returns that
 * one (a retried hand-off), and refreshes its lease. Serialized per business.
 */
export async function admitTurn(input: {
  orgId: string;
  memberId?: string | null;
  channel: UsageChannel;
  key: string;
  eveSessionId?: string | null;
  now?: Date;
}): Promise<Admission> {
  const now = input.now ?? new Date();
  return db().transaction(async (tx) => {
    await lockOrg(tx, input.orgId);
    await expireStalled(tx, input.orgId, now);
    const [existing] = await tx
      .select({ id: turnReservations.id })
      .from(turnReservations)
      .where(and(eq(turnReservations.orgId, input.orgId), eq(turnReservations.key, input.key), inArray(turnReservations.status, [...ACTIVE])))
      .limit(1);
    if (existing) {
      await tx
        .update(turnReservations)
        .set({ leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now })
        .where(and(eq(turnReservations.orgId, input.orgId), eq(turnReservations.id, existing.id)));
      return { ok: true, reservationId: existing.id, duplicate: true };
    }
    const { limits } = await limitsFor(input.orgId, tx);
    const reserve = Math.min(turnOutputReserve(), limits.hourlyOutputTokens);
    const { counted, receipts, window } = await windowOf(tx, input.orgId, now);
    const over: Array<{ reason: LimitReason; at: number }> = [];
    if (window.turns >= limits.hourlyTurns) {
      // The turn that has to leave the window for this one to fit.
      const leaving = counted[window.turns - limits.hourlyTurns];
      over.push({ reason: "hourly_turns", at: leaving.createdAt.getTime() + WINDOW_MS + 1_000 });
    }
    if (window.outputTokens + reserve > limits.hourlyOutputTokens) {
      over.push({ reason: "hourly_output_tokens", at: tokensFreeAt(receipts, window.outputTokens + reserve - limits.hourlyOutputTokens, now) });
    }
    if (window.active >= limits.concurrentTurns) over.push({ reason: "concurrent_turns", at: now.getTime() + 30_000 });
    if (over.length) {
      const retryAt = clampRetry(Math.max(...over.map((o) => o.at)), now);
      console.info("usage limits: a turn was held back", { orgId: input.orgId, channel: input.channel, reason: over[0].reason, retryAt: retryAt.toISOString() });
      return { ok: false, reason: over[0].reason, retryAt, limits, window };
    }
    const id = newId("rsv");
    await tx.insert(turnReservations).values({
      id,
      orgId: input.orgId,
      key: input.key,
      memberId: input.memberId ?? null,
      channel: input.channel,
      status: "reserved",
      reservedOutputTokens: reserve,
      eveSessionId: input.eveSessionId ?? null,
      leaseUntil: new Date(now.getTime() + LEASE_MS),
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true, reservationId: id, duplicate: false };
  });
}

/**
 * Admits one model call that isn't a turn (a translation), against the business's hourly output
 * tokens only, holding `outputTokens` until its receipt comes in. Settle it with `settleTurn` when the
 * call ends. Over the limit, says when to try again, like `admitTurn`.
 */
export async function admitModelCall(input: {
  orgId: string;
  memberId?: string | null;
  channel: (typeof NOT_TURNS)[number];
  outputTokens: number;
  now?: Date;
}): Promise<Admission> {
  const now = input.now ?? new Date();
  return db().transaction(async (tx) => {
    await lockOrg(tx, input.orgId);
    await expireStalled(tx, input.orgId, now);
    const { limits } = await limitsFor(input.orgId, tx);
    const reserve = Math.max(0, Math.min(input.outputTokens, limits.hourlyOutputTokens));
    const { receipts, window } = await windowOf(tx, input.orgId, now);
    if (window.outputTokens + reserve > limits.hourlyOutputTokens) {
      const retryAt = clampRetry(tokensFreeAt(receipts, window.outputTokens + reserve - limits.hourlyOutputTokens, now), now);
      console.info("usage limits: a model call was held back", { orgId: input.orgId, channel: input.channel, retryAt: retryAt.toISOString() });
      return { ok: false, reason: "hourly_output_tokens", retryAt, limits, window };
    }
    const id = newId("rsv");
    await tx.insert(turnReservations).values({
      id,
      orgId: input.orgId,
      key: `${input.channel}:${crypto.randomUUID()}`,
      memberId: input.memberId ?? null,
      channel: input.channel,
      status: "running",
      reservedOutputTokens: reserve,
      leaseUntil: new Date(now.getTime() + LEASE_MS),
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true, reservationId: id, duplicate: false };
  });
}

/**
 * eve started the reserved turn. Any older reservation for the same session that never started was
 * folded into this turn by eve's queue: it's `merged`, and stops holding a slot or counting as a turn.
 */
export async function markTurnRunning(orgId: string, reservationId: string, turn: { eveSessionId: string; turnId: string }, now: Date = new Date()): Promise<void> {
  await db().transaction(async (tx) => {
    await lockOrg(tx, orgId);
    const [row] = await tx
      .update(turnReservations)
      .set({
        status: "running",
        eveSessionId: turn.eveSessionId,
        turnId: turn.turnId,
        startedAt: sql`coalesce(${turnReservations.startedAt}, ${now.toISOString()}::timestamptz)`,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        updatedAt: now,
      })
      .where(and(eq(turnReservations.orgId, orgId), eq(turnReservations.id, reservationId), inArray(turnReservations.status, ["reserved", "running", "expired"])))
      .returning({ createdAt: turnReservations.createdAt });
    if (!row) return;
    await tx
      .update(turnReservations)
      .set({ status: "merged", settledAt: now, updatedAt: now })
      .where(
        and(
          eq(turnReservations.orgId, orgId),
          eq(turnReservations.eveSessionId, turn.eveSessionId),
          eq(turnReservations.status, "reserved"),
          ne(turnReservations.id, reservationId),
          lte(turnReservations.createdAt, row.createdAt),
        ),
      );
  });
}

/** A model call was heard from: the turn is alive, so its lease runs on. */
export async function extendLease(orgId: string, reservationId: string, now: Date = new Date()): Promise<void> {
  await db()
    .update(turnReservations)
    .set({ leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now })
    .where(and(eq(turnReservations.orgId, orgId), eq(turnReservations.id, reservationId), inArray(turnReservations.status, [...ACTIVE])));
}

/** The turn ended (completed, failed, or cancelled): its slot and held tokens are freed. */
export async function settleTurn(orgId: string, reservationId: string, now: Date = new Date()): Promise<void> {
  await db()
    .update(turnReservations)
    .set({ status: "settled", settledAt: now, updatedAt: now })
    .where(and(eq(turnReservations.orgId, orgId), eq(turnReservations.id, reservationId), inArray(turnReservations.status, ["reserved", "running", "expired"])));
}

/** The turn never reached eve (it refused the request): it doesn't count at all. */
export async function releaseTurn(orgId: string, reservationId: string, now: Date = new Date()): Promise<void> {
  await db()
    .update(turnReservations)
    .set({ status: "released", settledAt: now, updatedAt: now })
    .where(and(eq(turnReservations.orgId, orgId), eq(turnReservations.id, reservationId), eq(turnReservations.status, "reserved")));
}

/** The business's last hour against its limits, for the usage pages. */
export async function usageNow(orgId: string, now: Date = new Date()): Promise<{ window: UsageWindow; limits: Limits; overrides: LimitOverrides; defaults: Limits }> {
  return db().transaction(async (tx) => {
    await lockOrg(tx, orgId);
    await expireStalled(tx, orgId, now);
    const { window } = await windowOf(tx, orgId, now);
    const { limits, overrides } = await limitsFor(orgId, tx);
    return { window, limits, overrides, defaults: defaultLimits() };
  });
}

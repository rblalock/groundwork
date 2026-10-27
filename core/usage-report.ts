// What a business's assistant used, from its usage receipts (core/usage.ts): for one calendar
// month in the business's time zone, the totals, by channel, by member, and by day. Costs are
// estimates from list prices. Scoped to one `orgId`, except `allBusinessesUsage`, the super admins'
// summary, which reads across businesses on purpose.
import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { members, organization, usageLimits, usageReceipts } from "../schema/schema";
import { db } from "./db";
import { resolveLocalTime } from "./scheduling-time";
import { todayYmd } from "./time";
import type { UsageChannel } from "./usage-limits";

export type UsageTotals = {
  turns: number;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number;
};

export type MonthlyUsage = {
  month: string;
  timeZone: string;
  range: { start: string; end: string };
  totals: UsageTotals;
  byChannel: Array<UsageTotals & { channel: UsageChannel }>;
  byMember: Array<UsageTotals & { memberId: string | null; name: string | null }>;
  /** Every day of the month so far, oldest first, zeros included. */
  byDay: Array<UsageTotals & { day: string }>;
  /** Some calls were priced at the default deployment's rates: their deployment isn't in the table. */
  fallbackPriced: boolean;
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonth(value: string | null | undefined): value is string {
  return typeof value === "string" && MONTH.test(value);
}

function nextMonth(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, "0")}`;
}

/** The month's first and next month's first instant, in the business's time zone. */
export function monthRange(month: string, timeZone: string): { start: Date; end: Date } {
  return { start: resolveLocalTime(`${month}-01`, "00:00", timeZone), end: resolveLocalTime(`${nextMonth(month)}-01`, "00:00", timeZone) };
}

export const currentMonth = (timeZone: string, now: Date = new Date()) => todayYmd(timeZone, now).slice(0, 7);

const totalsColumns = {
  turns: sql<number>`count(distinct (${usageReceipts.eveSessionId}, ${usageReceipts.turnId})) filter (where ${usageReceipts.turnId} is not null)::int`,
  calls: sql<number>`count(*)::int`,
  inputTokens: sql<number>`coalesce(sum(${usageReceipts.inputTokens}), 0)::bigint`,
  cachedInputTokens: sql<number>`coalesce(sum(${usageReceipts.cachedInputTokens}), 0)::bigint`,
  outputTokens: sql<number>`coalesce(sum(${usageReceipts.outputTokens}), 0)::bigint`,
  reasoningTokens: sql<number>`coalesce(sum(${usageReceipts.reasoningTokens}), 0)::bigint`,
  estimatedCostUsd: sql<string>`coalesce(sum(${usageReceipts.estimatedCostUsd}), 0)`,
};

type RawTotals = { [K in keyof typeof totalsColumns]: number | string };

const toTotals = (row: RawTotals | undefined): UsageTotals => ({
  turns: Number(row?.turns ?? 0),
  calls: Number(row?.calls ?? 0),
  inputTokens: Number(row?.inputTokens ?? 0),
  cachedInputTokens: Number(row?.cachedInputTokens ?? 0),
  outputTokens: Number(row?.outputTokens ?? 0),
  reasoningTokens: Number(row?.reasoningTokens ?? 0),
  estimatedCostUsd: Number(row?.estimatedCostUsd ?? 0),
});

const ZERO = toTotals(undefined);

function daysOf(month: string, timeZone: string, now: Date): string[] {
  const last = currentMonth(timeZone, now) === month ? Number(todayYmd(timeZone, now).slice(8, 10)) : Number(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate());
  return Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

/** One business's usage for a month (this one by default), in its time zone. */
export async function monthlyUsage(orgId: string, options: { timeZone: string; month?: string; now?: Date }): Promise<MonthlyUsage> {
  const now = options.now ?? new Date();
  const month = isMonth(options.month) ? options.month : currentMonth(options.timeZone, now);
  const range = monthRange(month, options.timeZone);
  const scope = and(eq(usageReceipts.orgId, orgId), gte(usageReceipts.createdAt, range.start), lt(usageReceipts.createdAt, range.end));
  const day = sql<string>`to_char(${usageReceipts.createdAt} at time zone ${options.timeZone}, 'YYYY-MM-DD')`;
  const [[totals], channels, people, days, [fallback]] = await Promise.all([
    db().select(totalsColumns).from(usageReceipts).where(scope),
    db().select({ channel: usageReceipts.channel, ...totalsColumns }).from(usageReceipts).where(scope).groupBy(usageReceipts.channel),
    db()
      .select({ memberId: usageReceipts.memberId, name: members.name, ...totalsColumns })
      .from(usageReceipts)
      .leftJoin(members, and(eq(members.orgId, usageReceipts.orgId), eq(members.id, usageReceipts.memberId)))
      .where(scope)
      .groupBy(usageReceipts.memberId, members.name),
    // By position: the day expression's time zone is a parameter, and two copies of it wouldn't match.
    db().select({ day, ...totalsColumns }).from(usageReceipts).where(scope).groupBy(sql`1`),
    db()
      .select({ count: sql<number>`count(*)::int` })
      .from(usageReceipts)
      .where(and(scope, eq(usageReceipts.priceSource, "fallback"))),
  ]);
  const byDayMap = new Map(days.map((row) => [row.day, toTotals(row)]));
  const byCost = <T extends UsageTotals>(a: T, b: T) => b.estimatedCostUsd - a.estimatedCostUsd || b.outputTokens - a.outputTokens;
  return {
    month,
    timeZone: options.timeZone,
    range: { start: range.start.toISOString(), end: range.end.toISOString() },
    totals: toTotals(totals),
    byChannel: channels.map((row) => ({ channel: row.channel as UsageChannel, ...toTotals(row) })).sort(byCost),
    byMember: people.map((row) => ({ memberId: row.memberId, name: row.name, ...toTotals(row) })).sort(byCost),
    byDay: daysOf(month, options.timeZone, now).map((d) => ({ day: d, ...(byDayMap.get(d) ?? ZERO) })),
    fallbackPriced: (fallback?.count ?? 0) > 0,
  };
}

/** `customLimits`: a super admin set at least one of the business's own limits. */
export type BusinessUsageRow = UsageTotals & { orgId: string; name: string; suspended: boolean; customLimits: boolean };

/**
 * Every business's usage since `since` (by default the last 30 days), most expensive first, for the
 * super admins. Reads across businesses on purpose; only `requireSuperAdmin` pages call it.
 */
export async function allBusinessesUsage(options: { since: Date; until?: Date }): Promise<BusinessUsageRow[]> {
  const until = options.until ?? new Date();
  const rows = await db()
    .select({ orgId: usageReceipts.orgId, ...totalsColumns })
    .from(usageReceipts)
    .where(and(gte(usageReceipts.createdAt, options.since), lt(usageReceipts.createdAt, until)))
    .groupBy(usageReceipts.orgId);
  const orgs = await db()
    .select({
      id: organization.id,
      name: organization.name,
      suspended: organization.suspended,
      customLimits: sql<boolean>`(${usageLimits.hourlyTurns} is not null or ${usageLimits.hourlyOutputTokens} is not null or ${usageLimits.concurrentTurns} is not null)`,
    })
    .from(organization)
    .leftJoin(usageLimits, eq(usageLimits.orgId, organization.id))
    .orderBy(asc(organization.name));
  const byOrg = new Map(rows.map((row) => [row.orgId, toTotals(row)]));
  return orgs
    .map((org) => ({ orgId: org.id, name: org.name, suspended: org.suspended, customLimits: Boolean(org.customLimits), ...(byOrg.get(org.id) ?? ZERO) }))
    .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || b.outputTokens - a.outputTokens || a.name.localeCompare(b.name));
}

/** The business's most recent receipts, newest first, for the admin page. */
export async function recentReceipts(orgId: string, limit = 20) {
  return db()
    .select({
      id: usageReceipts.id,
      at: usageReceipts.createdAt,
      channel: usageReceipts.channel,
      kind: usageReceipts.kind,
      deployment: usageReceipts.deployment,
      memberName: members.name,
      inputTokens: usageReceipts.inputTokens,
      cachedInputTokens: usageReceipts.cachedInputTokens,
      outputTokens: usageReceipts.outputTokens,
      reasoningTokens: usageReceipts.reasoningTokens,
      estimatedCostUsd: usageReceipts.estimatedCostUsd,
      priceSource: usageReceipts.priceSource,
    })
    .from(usageReceipts)
    .leftJoin(members, and(eq(members.orgId, usageReceipts.orgId), eq(members.id, usageReceipts.memberId)))
    .where(eq(usageReceipts.orgId, orgId))
    .orderBy(desc(usageReceipts.createdAt), desc(usageReceipts.id))
    .limit(limit);
}

// The evening weather check, from the hourly schedule. Once the business's next workday is `weatherLeadHours`
// away (5 PM before an 8 AM start), it takes the yard's forecast (`core/weather.ts`) and reads tomorrow's
// weather-sensitive stops against the business's limits: a stop is at risk when the chance of rain over its window
// reaches the rain limit, or its hottest hour the heat limit. The stops at risk go into one `move_weather` proposal
// for the business (`core/proposals.ts`), each to its own crew's next dry day with room: a later slot the forecast
// puts under both limits, or past the forecast's reach. Nothing moves today, and nothing moves until an owner or
// admin applies it. One per business and day: a proposal raised for tomorrow, answered or not, isn't raised again.
// A stop's work is weather-sensitive when any of the items on its quote's current lines is.
import { and, eq, inArray } from "drizzle-orm";
import { customers, members, pricebookItems, proposals, quoteRevisions, quotes } from "../schema/schema";
import type { ProposalItem } from "../schema/types";
import { db, newId } from "./db";
import { isLanguage, type Language } from "./language";
import { listOrganizations } from "./organizations";
import { yardOf } from "./places";
import { getProfile, type Profile } from "./profile";
import { claimSlot, crewLine, customerText, expireProposals, pickSlot, sendProposal, slotTarget, type Claimed, type Proposal } from "./proposals";
import type { Poster } from "./quotes";
import { findAvailability, visitsOnDay, type Slot, type VisitView } from "./scheduling";
import { minutesClock, resolveLocalTime, timeText, wallClock, workingSegments } from "./scheduling-time";
import { addDays } from "./time";
import { atRiskWindow, dayWeather, forecastFor, spanText, thresholdsOf, weatherDayWord, type Forecast, type WeatherThresholds } from "./weather";

const HOUR = 3_600_000;
const MINUTE = 60_000;
/** How many days past the day at risk a stop may move to. */
const LATER_DAYS = 14;
/** When the business has no hours that day, the workday the check counts back from starts at 8. */
const DEFAULT_START = 8 * 60;

const languageOf = (value: unknown): Language => (isLanguage(value) ? value : "en");
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** When the check for `date` runs: the business's first working hour that day, less the lead hours. */
export function weatherCheckAt(profile: Pick<Profile, "workHours" | "timeZone" | "weatherLeadHours">, date: string): Date {
  const [first] = workingSegments(date, profile.workHours);
  const start = resolveLocalTime(date, minutesClock(first?.start ?? DEFAULT_START), profile.timeZone);
  return new Date(start.getTime() - profile.weatherLeadHours * HOUR);
}

/**
 * The weather-sensitive items on each quote's current lines, by quote: their names, in line order. Quotes with none
 * are left out.
 */
export async function weatherSensitiveWork(orgId: string, quoteIds: string[]): Promise<Map<string, string[]>> {
  const ids = [...new Set(quoteIds)];
  if (!ids.length) return new Map();
  const rows = await db()
    .select({ quoteId: quotes.id, lines: quoteRevisions.lines })
    .from(quotes)
    .innerJoin(quoteRevisions, and(eq(quoteRevisions.orgId, quotes.orgId), eq(quoteRevisions.id, quotes.currentRevisionId)))
    .where(and(eq(quotes.orgId, orgId), inArray(quotes.id, ids)));
  const itemIds = [...new Set(rows.flatMap((row) => row.lines.flatMap((line) => (line.itemId ? [line.itemId] : []))))];
  if (!itemIds.length) return new Map();
  const items = await db()
    .select({ id: pricebookItems.id, name: pricebookItems.name })
    .from(pricebookItems)
    .where(and(eq(pricebookItems.orgId, orgId), inArray(pricebookItems.id, itemIds), eq(pricebookItems.weatherSensitive, true)));
  const names = new Map(items.map((item) => [item.id, item.name]));
  const work = new Map<string, string[]>();
  for (const row of rows) {
    const sensitive = [...new Set(row.lines.flatMap((line) => (line.itemId && names.has(line.itemId) ? [names.get(line.itemId)!] : [])))];
    if (sensitive.length) work.set(row.quoteId, sensitive);
  }
  return work;
}

// ---------------------------------------------------------------------------------------------
// Building one

/** A stop of tomorrow's whose work is weather-sensitive: its visit, its customer's language, and the work's names. */
export type WeatherStop = Pick<
  VisitView,
  "visitId" | "title" | "startAt" | "endAt" | "crew" | "revision" | "customerName" | "bufferBeforeMinutes" | "bufferAfterMinutes"
> & { customerLanguage: Language; work: string[] };

export type WeatherContext = {
  now: Date;
  /** The business's today, and the day checked (tomorrow). */
  today: string;
  date: string;
  timeZone: string;
  business: string;
  /** The business's language, which the reason is written in. */
  language: Language;
  thresholds: WeatherThresholds;
  forecast: Forecast;
  memberLanguages: Map<string, Language>;
  /** A stop's crew's slots on one later day. */
  slotsFor: (stop: WeatherStop, date: string) => Promise<Slot[]>;
};

type AtRisk = { stop: WeatherStop; risk: NonNullable<ReturnType<typeof atRiskWindow>> };

/**
 * The reason, one line: "Rain likely tomorrow 10 AM–2 PM (70%) over 3 lawn mowing stops", and "; heat likely …"
 * when some are at risk from heat. The window is the day's hours at or over the limit; the work is named once when
 * it's one kind, else listed.
 */
export function weatherReason(atRisk: AtRisk[], ctx: Pick<WeatherContext, "forecast" | "date" | "today" | "timeZone" | "thresholds" | "language">): string {
  const es = ctx.language === "es";
  const day = dayWeather(ctx.forecast, ctx.date, ctx.timeZone, ctx.thresholds);
  const word = weatherDayWord(ctx.date, ctx.today, ctx.language);
  const parts: string[] = [];
  for (const cause of ["rain", "heat"] as const) {
    const group = atRisk.filter((a) => a.risk.reason === cause);
    if (!group.length) continue;
    const n = group.length;
    const names = [...new Set(group.flatMap((a) => a.stop.work.map(lowerFirst)))];
    const stops = es ? (n === 1 ? "parada" : "paradas") : n === 1 ? "stop" : "stops";
    const what =
      names.length === 1 ? (es ? `${n} ${stops} de ${names[0]}` : `${n} ${names[0]} ${stops}`) : `${n} ${stops} (${names.join(", ")})`;
    const span = cause === "rain" ? day?.rain : day?.heat;
    const value = cause === "rain" ? `${Math.max(...group.map((a) => a.risk.rainPct))}%` : `${Math.max(...group.map((a) => a.risk.tempF))}°F`;
    const when = span
      ? es
        ? ` de ${timeText(span.from, ctx.timeZone, ctx.language)} a ${timeText(span.to, ctx.timeZone, ctx.language)}`
        : ` ${spanText(span, ctx.timeZone, ctx.language)}`
      : "";
    const likely = es ? (cause === "rain" ? "Lluvia probable" : "Calor probable") : cause === "rain" ? "Rain likely" : "Heat likely";
    parts.push(`${likely} ${word}${when} (${value}) ${es ? "en" : "over"} ${what}`);
  }
  return parts.map((part, i) => (i ? lowerFirst(part) : part)).join("; ");
}

/**
 * A weather proposal for a day: the stops `atRiskWindow` marks, in time order, each to its own crew's first later
 * day with a slot that fits, isn't over time an earlier stop was given, and that the forecast puts under both limits
 * (past its reach counts as dry). Stops with nowhere to go stay off it. Null when no stop is at risk; with stops at
 * risk and none placed, the reason with no items. Pure but for `slotsFor`.
 */
export async function buildWeatherProposal(stops: WeatherStop[], ctx: WeatherContext): Promise<{ reason: string; atRisk: number; items: ProposalItem[] } | null> {
  const atRisk = [...stops]
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
    .flatMap((stop) => {
      const risk = stop.crew.length ? atRiskWindow(ctx.forecast, stop.startAt, stop.endAt, ctx.thresholds) : null;
      return risk ? [{ stop, risk }] : [];
    });
  if (!atRisk.length) return null;
  const claimed: Claimed = new Map();
  const items: ProposalItem[] = [];
  for (const { stop, risk } of atRisk) {
    let slot: Slot | null = null;
    for (let d = 1; d <= LATER_DAYS && !slot; d++) {
      const dry = (await ctx.slotsFor(stop, addDays(ctx.date, d))).filter((s) => !atRiskWindow(ctx.forecast, s.startAt, s.endAt, ctx.thresholds));
      slot = pickSlot(dry, "later", { memberId: stop.crew[0].memberId, date: ctx.date, earliest: ctx.now, claimed });
    }
    if (!slot) continue;
    claimSlot(claimed, slot);
    const move = {
      title: stop.title,
      date: ctx.date,
      from: { startAt: stop.startAt },
      to: { startAt: slot.startAt, endAt: slot.endAt, names: slot.crew.map((c) => c.name) },
      cause: risk.reason,
    };
    items.push({
      id: String(items.length + 1),
      visitId: stop.visitId,
      revision: stop.revision,
      title: stop.title,
      customerName: stop.customerName,
      from: { startAt: stop.startAt.toISOString(), endAt: stop.endAt.toISOString(), memberIds: stop.crew.map((c) => c.memberId) },
      to: slotTarget(slot, stop),
      customerText: customerText(move, { name: stop.customerName, language: stop.customerLanguage }, ctx.business, ctx.timeZone),
      crewText: crewLine({ ...move, takesOver: null }, ctx.timeZone, ctx.memberLanguages.get(slot.crew[0].memberId) ?? "en"),
    });
  }
  return { reason: weatherReason(atRisk, ctx), atRisk: atRisk.length, items };
}

// ---------------------------------------------------------------------------------------------
// Raising one

/**
 * Raises the weather proposal for the business's next day, once: none before the check's time, when one was raised
 * for that day already (decided or not), with no weather-sensitive stops, without a placed yard or a forecast, or
 * when no stop is at risk or none can move.
 */
export async function proposeWeatherMoves(orgId: string, now: Date): Promise<Proposal | null> {
  const profile = await getProfile(orgId);
  const timeZone = profile.timeZone;
  const today = wallClock(now, timeZone).date;
  const date = addDays(today, 1);
  if (now < weatherCheckAt(profile, date)) return null;
  const [raised] = await db()
    .select({ id: proposals.id })
    .from(proposals)
    .where(and(eq(proposals.orgId, orgId), eq(proposals.kind, "move_weather"), eq(proposals.date, date)))
    .limit(1);
  if (raised) return null;
  const visits = (await visitsOnDay(orgId, date, timeZone)).filter((v) => v.crew.length > 0 && !v.startedAt);
  const work = await weatherSensitiveWork(orgId, visits.flatMap((v) => (v.quoteId ? [v.quoteId] : [])));
  const sensitive = visits.filter((v) => v.quoteId && work.has(v.quoteId));
  if (!sensitive.length) return null;
  const yard = yardOf(profile);
  if (!yard) {
    console.info("weather: tomorrow has weather-sensitive stops, and the yard isn't placed", { orgId, date });
    return null;
  }
  // The forecast is the yard's: a business's stops share its grid, near enough.
  const forecast = await forecastFor(yard, { now, timeZone });
  if (!forecast) return null;
  const customerIds = [...new Set(sensitive.flatMap((v) => (v.customerId ? [v.customerId] : [])))];
  const customerRows = customerIds.length
    ? await db().select({ id: customers.id, language: customers.language }).from(customers).where(and(eq(customers.orgId, orgId), inArray(customers.id, customerIds)))
    : [];
  const memberRows = await db().select({ id: members.id, language: members.language }).from(members).where(eq(members.orgId, orgId));
  const viewer = { orgId, memberId: null, role: "owner" as const };
  const built = await buildWeatherProposal(
    sensitive.map((v) => ({ ...v, customerLanguage: languageOf(customerRows.find((c) => c.id === v.customerId)?.language), work: work.get(v.quoteId!) ?? [] })),
    {
      now,
      today,
      date,
      timeZone,
      business: profile.name,
      language: languageOf(profile.language),
      thresholds: thresholdsOf(profile),
      forecast,
      memberLanguages: new Map(memberRows.map((m) => [m.id, languageOf(m.language)])),
      slotsFor: async (stop, day) =>
        (
          await findAvailability(
            viewer,
            {
              memberIds: stop.crew.map((c) => c.memberId),
              from: day,
              days: 1,
              durationMinutes: Math.round((stop.endAt.getTime() - stop.startAt.getTime()) / MINUTE),
              reschedulingVisitId: stop.visitId,
              limit: 100,
            },
            { now },
          )
        ).slots,
    },
  );
  if (!built) return null;
  if (!built.items.length) {
    console.info("weather: stops are at risk tomorrow, with nowhere dry to move them", { orgId, date, atRisk: built.atRisk });
    return null;
  }
  const [stored] = await db()
    .insert(proposals)
    .values({ id: newId("prop"), orgId, kind: "move_weather", memberId: null, date, reason: built.reason, items: built.items, createdAt: now })
    .onConflictDoNothing()
    .returning();
  return stored ?? null;
}

/** One business's weather check: raises tomorrow's proposal and texts it to the owners (quiet hours queue it). */
export async function checkWeather(orgId: string, now: Date, deps?: { post?: Poster }): Promise<{ proposal: Proposal; sent: string[] } | null> {
  const proposal = await proposeWeatherMoves(orgId, now);
  if (!proposal) return null;
  const sent = await sendProposal(orgId, proposal, { now, post: deps?.post });
  console.info("weather: proposed moving stops", { orgId, proposalId: proposal.id, items: proposal.items.length, sent: sent.length });
  return { proposal, sent };
}

/** The hourly schedule's entry point: every business that isn't paused, its proposals past their day expired first. A failure is logged, never thrown. */
export async function weatherTick(now: Date = new Date()): Promise<number> {
  let count = 0;
  try {
    for (const org of await listOrganizations()) {
      if (org.suspended) continue;
      try {
        await expireProposals(org.id, now);
        if (await checkWeather(org.id, now)) count++;
      } catch (error) {
        console.error("weather: the check failed for a business", { orgId: org.id, error });
      }
    }
  } catch (error) {
    console.error("weather: the check failed", error);
  }
  return count;
}

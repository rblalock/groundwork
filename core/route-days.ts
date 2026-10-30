// Route days: recurring work placed by area, so each weekday's recurring stops are one loop from the yard. The
// business's recurring jobs at placed addresses are sorted by their bearing from the yard and the circle is cut
// into contiguous arcs, one per weekday the business works (Monday to Friday, from its hours), balanced by count
// and starting after the widest gap between neighbours, so no arc spans empty ground. Arcs go to the weekdays
// that keep the most jobs on the day they have. Each job whose day changes is an item of one `route_days`
// proposal (`core/proposals.ts`): its next open visit to the first fitting slot on its new weekday next week, with
// its own crew. Nothing moves until an owner or admin applies it, which also puts the work on its new weekday.
// Raised on demand only: `plan_route_days` by text, or the Schedule page's button. Nothing here reaches a
// customer: their texts are drafts the owner forwards. New recurring work is offered the weekday whose recurring
// stops it's nearest (`routeDayFor`): the one whose loop from the yard it adds the least driving to.
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { customers, properties, proposals, quoteRevisions, quotes, serviceJobs } from "../schema/schema";
import type { ProposalItem, WorkingInterval } from "../schema/types";
import { db, newId } from "./db";
import { isLanguage, type Language } from "./language";
import { isPrivileged } from "./members";
import { DEFAULT_DRIVE, driveSettingsOf, type DriveSettings, type Point } from "./places";
import { getProfile } from "./profile";
import { claimSlot, ownerText, pickSlot, slotTarget, weekdayWord, type Claimed, type Proposal } from "./proposals";
import { weekdayName } from "./recurrence";
import { routeDriveMinutes, suggestOrder } from "./route-order";
import { findAvailability, nextOpenVisits, slotLines, type Actor, type Slot, type Viewer } from "./scheduling";
import { dayText, timeText, wallClock, weekStart, weekdayOf } from "./scheduling-time";
import { addDays } from "./time";

const MINUTE = 60_000;
const languageOf = (value: unknown): Language => (isLanguage(value) ? value : "en");
const firstName = (name: string) => name.split(/\s+/)[0] ?? name;
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
/** Ends a sentence once: Spanish clocks already end in "p.m.". */
const sentence = (text: string) => (text.endsWith(".") ? text : `${text}.`);
/** A Sunday, to name a weekday by: "Tue" is this plus 2. */
const SUNDAY = "2026-11-01";
const shortWeekday = (weekday: number, language: Language) => weekdayWord(addDays(SUNDAY, weekday), language);

// ---------------------------------------------------------------------------------------------
// Areas

/** Degrees clockwise from north, 0 to 360, from `from` to `to`: near enough flat at a county's size. */
export function bearingFrom(from: Point, to: Point): number {
  const east = (to.lng - from.lng) * Math.cos((((from.lat + to.lat) / 2) * Math.PI) / 180);
  const north = to.lat - from.lat;
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

/**
 * The stops cut into `count` contiguous arcs by bearing from the yard (fewer when there are fewer stops). The arcs
 * start after the widest gap between neighbouring bearings, go clockwise, and differ by one stop at most, the
 * larger ones first. Pure.
 */
export function cutArcs<T extends { place: Point }>(yard: Point, stops: T[], count: number): T[][] {
  const n = stops.length;
  const k = Math.min(Math.max(Math.trunc(count), 0), n);
  if (k === 0) return [];
  const sorted = stops.map((stop) => ({ stop, bearing: bearingFrom(yard, stop.place) })).sort((a, b) => a.bearing - b.bearing);
  let start = 0;
  let widest = -1;
  for (let i = 0; i < n; i++) {
    const gap = i === n - 1 ? sorted[0].bearing + 360 - sorted[i].bearing : sorted[i + 1].bearing - sorted[i].bearing;
    if (gap > widest) {
      widest = gap;
      start = (i + 1) % n;
    }
  }
  const ordered = [...sorted.slice(start), ...sorted.slice(0, start)].map((s) => s.stop);
  const arcs: T[][] = [];
  let at = 0;
  for (let i = 0; i < k; i++) {
    const size = Math.floor(n / k) + (i < n % k ? 1 : 0);
    arcs.push(ordered.slice(at, at + size));
    at += size;
  }
  return arcs;
}

/**
 * The weekday each arc gets, one each: the matching that leaves the most stops on the weekday they have, and of
 * those the first in weekday order. Pure.
 */
export function assignWeekdays(arcs: Array<Array<{ weekday: number | null }>>, weekdays: number[]): number[] {
  let best: number[] = [];
  let bestKept = -1;
  const pick = (chosen: number[]) => {
    if (chosen.length === arcs.length) {
      const kept = arcs.reduce((sum, arc, i) => sum + arc.filter((stop) => stop.weekday === chosen[i]).length, 0);
      if (kept > bestKept) {
        bestKept = kept;
        best = chosen;
      }
      return;
    }
    for (const day of weekdays) if (!chosen.includes(day)) pick([...chosen, day]);
  };
  pick([]);
  return best;
}

/** Monday to Friday, the days the business works: those with working hours. */
export function workWeekdays(hours: WorkingInterval[]): number[] {
  return [...new Set(hours.filter((h) => h.day >= 1 && h.day <= 5).map((h) => h.day))].sort((a, b) => a - b);
}

/** A recurring job to place: where it is, and the weekday it's on now (null when it has none yet). */
export type RouteJob = { jobId: string; place: Point; weekday: number | null };
export type RouteDay<T extends RouteJob = RouteJob> = { weekday: number; jobs: T[] };

/** The business's route days: each weekday's arc of recurring jobs (`cutArcs`, `assignWeekdays`), in weekday order. Pure. */
export function planRouteDays<T extends RouteJob>(yard: Point, jobs: T[], weekdays: number[]): Array<RouteDay<T>> {
  const arcs = cutArcs(yard, jobs, weekdays.length);
  const days = assignWeekdays(arcs, weekdays);
  return arcs.map((arc, i) => ({ weekday: days[i], jobs: arc })).sort((a, b) => a.weekday - b.weekday);
}

/** A weekday's recurring stops, as a loop from the yard and back. */
export type Loop = { weekday: number; places: Point[] };

/**
 * The loop a stop at `place` adds the least driving to (its shortest order from the yard and back, with it and
 * without, `suggestOrder`), and how much; on a tie the one with fewer stops, then the earlier weekday. Loops with no
 * stops don't count. Pure; null when none has a stop.
 */
export function nearestLoop(yard: Point, place: Point, loops: Loop[], settings: DriveSettings = DEFAULT_DRIVE): { weekday: number; addedDriveMinutes: number } | null {
  const loopMinutes = (places: Point[]) => routeDriveMinutes(yard, suggestOrder(yard, places.map((p) => ({ place: p })), settings).map((s) => s.place), settings);
  const scored = loops
    .filter((loop) => loop.places.length > 0)
    .map((loop) => ({ loop, added: Math.max(0, loopMinutes([...loop.places, place]) - loopMinutes(loop.places)) }))
    .sort((a, b) => a.added - b.added || a.loop.places.length - b.loop.places.length || a.loop.weekday - b.loop.weekday);
  const [best] = scored;
  return best ? { weekday: best.loop.weekday, addedDriveMinutes: best.added } : null;
}

// ---------------------------------------------------------------------------------------------
// Words

/** The reason, one line: "6 recurring stops by area, one loop a weekday (Mon 2, Tue 2, Wed 1, Thu 1)". */
export function routeDaysReason(days: RouteDay[], language: Language): string {
  const n = days.reduce((sum, day) => sum + day.jobs.length, 0);
  const list = days.map((day) => `${shortWeekday(day.weekday, language)} ${day.jobs.length}`).join(", ");
  return language === "es"
    ? `${n} ${n === 1 ? "parada recurrente" : "paradas recurrentes"} por zona, una ruta por día (${list})`
    : `${n} recurring ${n === 1 ? "stop" : "stops"} by area, one loop a weekday (${list})`;
}

/** "Nov 10"; "10 nov" in Spanish. */
const monthDay = (date: string, language: Language) =>
  new Intl.DateTimeFormat(language === "es" ? "es-US" : "en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00Z`));

/**
 * The draft for the customer, in their language, with no prices: "Hi Maria, it's Ortega Lawn. We're setting your
 * regular lawn mowing to Tuesdays, starting Nov 10 at 9 AM. Reply if that doesn't work." `work` is what's done
 * there (its quote's first line), else "visit".
 */
export function routeDayCustomerText(
  move: { work: string | null; to: { date: string; startAt: Date } },
  customer: { name: string | null; language: Language },
  business: string,
  timeZone: string,
): string {
  const lang = customer.language;
  const es = lang === "es";
  const hi = customer.name ? `${es ? "Hola" : "Hi"} ${firstName(customer.name)}` : es ? "Hola" : "Hi";
  const days = weekdayName(weekdayOf(move.to.date), lang, true);
  const at = timeText(move.to.startAt, timeZone, lang);
  const work = move.work ? lowerFirst(move.work) : null;
  return es
    ? `${hi}, le escribe ${business}. Pasamos su ${work ?? "visita"} regular a los ${days}, a partir del ${monthDay(move.to.date, lang)} a las ${sentence(at)} Avísenos si no le funciona.`
    : `${hi}, it's ${business}. We're setting your regular ${work ?? "visit"} to ${days}, starting ${monthDay(move.to.date, lang)} at ${sentence(at)} Reply if that doesn't work.`;
}

/** The line for the crew: "412 Oak St moves to Tuesdays, from Tue, Nov 10, 9 AM–10 AM." */
export function routeDayCrewText(move: { title: string; to: { date: string; startAt: Date; endAt: Date } }, timeZone: string, language: Language): string {
  const days = weekdayName(weekdayOf(move.to.date), language, true);
  const window = `${dayText(move.to.date, language)}, ${timeText(move.to.startAt, timeZone, language)}–${timeText(move.to.endAt, timeZone, language)}`;
  return sentence(language === "es" ? `${move.title} pasa a los ${days}, desde ${window}` : `${move.title} moves to ${days}, from ${window}`);
}

const NOTHING: Record<Language, { yard: string; hours: string; few: (n: number) => string; placed: string; noRoom: string }> = {
  en: {
    yard: "The yard's address isn't placed, so there's no telling which way each stop is. Set the business address in Settings first.",
    hours: "The business has no weekday hours (Monday to Friday) to give route days to.",
    few: (n) => `Route days need at least 2 recurring stops with a placed address; there ${n === 1 ? "is 1" : `are ${n}`}.`,
    placed: "Each one is already on its area's day, so nothing moves.",
    noRoom: "The stops that would change have no room on their new day next week, so nothing is proposed.",
  },
  es: {
    yard: "La dirección de la base no está ubicada, así que no se sabe hacia dónde queda cada parada. Primero pon la dirección del negocio en Ajustes.",
    hours: "El negocio no tiene horario de lunes a viernes para repartir días de ruta.",
    few: (n) => `Los días de ruta necesitan al menos 2 paradas recurrentes con dirección ubicada; ${n === 1 ? "hay 1" : `hay ${n}`}.`,
    placed: "Cada una ya está en el día de su zona, así que nada se mueve.",
    noRoom: "Las paradas que cambiarían no tienen lugar en su nuevo día la próxima semana, así que no hay propuesta.",
  },
};

// ---------------------------------------------------------------------------------------------
// Raising one

/** "your Tue loop"; "tu ruta del mar". */
export const loopLabel = (weekday: number, language: Language) =>
  language === "es" ? `tu ruta del ${shortWeekday(weekday, language)}` : `your ${shortWeekday(weekday, language)} loop`;

// ---------------------------------------------------------------------------------------------
// New recurring work

export type RouteDayHint = { weekday: number; label: string; addedDriveMinutes: number };

/**
 * The route day for recurring work at `place`: of the weekdays the business works, the one whose recurring stops
 * (other open recurring jobs set on that weekday, `excludeJobId` left out) it adds the least driving to
 * (`nearestLoop`). Null without a placed yard or place, or when no weekday has a recurring stop yet.
 */
export async function routeDayFor(orgId: string, input: { place: Point | null; excludeJobId?: string | null }, language: Language): Promise<RouteDayHint | null> {
  if (!input.place) return null;
  const profile = await getProfile(orgId);
  if (profile.yardLat === null || profile.yardLng === null) return null;
  const weekdays = workWeekdays(profile.workHours);
  const rows = (await placedRecurringJobs(orgId)).filter((row) => row.job.id !== input.excludeJobId);
  const loops = weekdays.map((weekday) => ({
    weekday,
    places: rows.filter((row) => row.job.recurrence?.weekday === weekday).map((row) => ({ lat: row.lat!, lng: row.lng! })),
  }));
  const best = nearestLoop({ lat: profile.yardLat, lng: profile.yardLng }, input.place, loops, driveSettingsOf(profile));
  return best ? { ...best, label: loopLabel(best.weekday, language) } : null;
}

/**
 * The lines to offer (`slotLines`) with the route day's best-ranked slot first, each of its lines saying so: "Tue,
 * Nov 10, 10 AM with Carlos (+5 min driving; your Tue loop)". The rest keep their rank. Pure.
 */
export function routeDayLines(slots: Slot[], timeZone: string, language: Language, routeDay: Pick<RouteDayHint, "weekday" | "label">): string[] {
  const onDay = (slot: Slot) => weekdayOf(slot.date) === routeDay.weekday;
  const best = slots.find(onDay);
  const ordered = best ? [best, ...slots.filter((s) => s !== best)] : slots;
  return slotLines(ordered, timeZone, language, 3, (slot) => (onDay(slot) ? routeDay.label : null));
}

/** The business's open recurring jobs at placed addresses. */
async function placedRecurringJobs(orgId: string) {
  return db()
    .select({ job: serviceJobs, lat: properties.lat, lng: properties.lng, customerLanguage: customers.language })
    .from(serviceJobs)
    .innerJoin(properties, and(eq(properties.orgId, orgId), eq(properties.id, serviceJobs.propertyId)))
    .leftJoin(customers, and(eq(customers.orgId, orgId), eq(customers.id, serviceJobs.customerId)))
    .where(
      and(
        eq(serviceJobs.orgId, orgId),
        eq(serviceJobs.status, "open"),
        isNotNull(serviceJobs.recurrence),
        isNotNull(properties.lat),
        isNotNull(properties.lng),
      ),
    );
}

/** How many open recurring jobs the business has at placed addresses: the Schedule page offers route days from 3. */
export async function recurringJobCount(orgId: string): Promise<number> {
  return (await placedRecurringJobs(orgId)).length;
}

/** What's done at each quote's work, for the customer drafts: its current revision's first line, by quote. */
async function workNames(orgId: string, quoteIds: string[]): Promise<Map<string, string>> {
  if (!quoteIds.length) return new Map();
  const rows = await db()
    .select({ quoteId: quotes.id, lines: quoteRevisions.lines })
    .from(quotes)
    .innerJoin(quoteRevisions, and(eq(quoteRevisions.orgId, quotes.orgId), eq(quoteRevisions.id, quotes.currentRevisionId)))
    .where(and(eq(quotes.orgId, orgId), inArray(quotes.id, [...new Set(quoteIds)])));
  return new Map(rows.flatMap((row) => (row.lines[0]?.name ? [[row.quoteId, row.lines[0].name] as const] : [])));
}

/**
 * Raises the business's route-day proposal, owners and admins only: the jobs whose area's weekday differs from the
 * one they're on, each with its next open visit placed on the new weekday next week (the first fitting slot for its
 * own crew, at its usual time when that's free, never over time an earlier item was given). A route-day proposal
 * still open is replaced. Returns the proposal and the owner's text for it, or, with none, the code's line on why.
 */
export async function proposeRouteDays(actor: Actor, deps?: { now?: Date }): Promise<{ proposal: Proposal | null; text: string }> {
  if (!isPrivileged(actor.role)) throw new Error("NOT_PRIVILEGED");
  const { orgId, language } = actor;
  const now = deps?.now ?? new Date();
  const words = NOTHING[language];
  const profile = await getProfile(orgId);
  const timeZone = profile.timeZone;
  if (profile.yardLat === null || profile.yardLng === null) return { proposal: null, text: words.yard };
  const yard = { lat: profile.yardLat, lng: profile.yardLng };
  const weekdays = workWeekdays(profile.workHours);
  if (!weekdays.length) return { proposal: null, text: words.hours };
  const rows = await placedRecurringJobs(orgId);
  if (rows.length < 2) return { proposal: null, text: words.few(rows.length) };
  const next = await nextOpenVisits(orgId, rows.map((r) => r.job.id), now);
  const jobs = rows.map((row) => {
    const visit = next.get(row.job.id) ?? null;
    const weekday = row.job.recurrence?.weekday ?? (visit ? weekdayOf(wallClock(visit.startAt, timeZone).date) : null);
    return { jobId: row.job.id, place: { lat: row.lat!, lng: row.lng! }, weekday, row, visit };
  });
  const days = planRouteDays(yard, jobs, weekdays);
  const reason = routeDaysReason(days, languageOf(profile.language));
  const names = await workNames(orgId, rows.flatMap((r) => (r.job.quoteId ? [r.job.quoteId] : [])));
  const viewer: Viewer = { orgId, memberId: null, role: "owner" };
  const today = wallClock(now, timeZone).date;
  const claimed: Claimed = new Map();
  const items: ProposalItem[] = [];
  let changing = 0;
  for (const day of days) {
    // The new weekday next week: Monday's week on, plus the days to it.
    const date = addDays(weekStart(today), 7 + ((day.weekday + 6) % 7));
    for (const { row, visit, weekday } of day.jobs) {
      if (weekday === day.weekday) continue;
      changing++;
      if (!visit || !visit.crew.length) continue;
      const usual = row.job.recurrence?.time ?? wallClock(visit.startAt, timeZone).time;
      const found = await findAvailability(
        viewer,
        {
          memberIds: visit.crew.map((c) => c.memberId),
          from: date,
          days: 1,
          durationMinutes: Math.round((visit.endAt.getTime() - visit.startAt.getTime()) / MINUTE),
          reschedulingVisitId: visit.visitId,
          limit: 100,
        },
        { now },
      );
      // Its usual time first when it's free, then the ranked rest.
      const ordered: Slot[] = [...found.slots.filter((s) => s.start === usual), ...found.slots.filter((s) => s.start !== usual)];
      const slot = pickSlot(ordered, "later", { memberId: visit.crew[0].memberId, date: addDays(date, -1), earliest: now, claimed });
      if (!slot) continue;
      claimSlot(claimed, slot);
      const to = { date: slot.date, startAt: slot.startAt, endAt: slot.endAt };
      items.push({
        id: String(items.length + 1),
        visitId: visit.visitId,
        revision: visit.revision,
        title: visit.title,
        customerName: visit.customerName,
        from: { startAt: visit.startAt.toISOString(), endAt: visit.endAt.toISOString(), memberIds: visit.crew.map((c) => c.memberId) },
        to: slotTarget(slot, visit),
        customerText: routeDayCustomerText(
          { work: (row.job.quoteId && names.get(row.job.quoteId)) || null, to },
          { name: visit.customerName, language: languageOf(row.customerLanguage) },
          profile.name,
          timeZone,
        ),
        crewText: routeDayCrewText({ title: visit.title, to }, timeZone, languageOf(profile.language)),
      });
    }
  }
  if (!items.length) return { proposal: null, text: `${reason}. ${changing ? words.noRoom : words.placed}` };
  const stored = await db().transaction(async (tx) => {
    // One route-day proposal open at a time: asking again replaces it.
    await tx
      .update(proposals)
      .set({ status: "expired", decidedAt: now })
      .where(and(eq(proposals.orgId, orgId), eq(proposals.kind, "route_days"), eq(proposals.status, "open")));
    const [row] = await tx
      .insert(proposals)
      .values({ id: newId("prop"), orgId, kind: "route_days", memberId: null, date: today, reason, items, createdAt: now })
      .returning();
    return row;
  });
  return { proposal: stored, text: ownerText(stored, null, timeZone, language) };
}

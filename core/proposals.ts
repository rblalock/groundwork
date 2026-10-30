// Proposals: a change the code works out and an owner or admin decides. For now one kind, `move_stops`: a crew
// member's day re-planned from now runs past its end plus the grace (`core/running-long.ts`), so the code picks
// their last stops not yet started and where each could go, and the owners get it as a numbered confirm by text
// and on the Schedule page. Nothing moves until they apply it, and applying re-checks every stop in one
// transaction; the stops that still hold move through the code `reschedule_visit` uses, and the crew are texted
// as they are for any move. Nothing here reaches a customer: each stop's customer text is a draft the owner
// forwards. Every time, choice, and check is made here; the assistant only relays the texts.
import { and, eq, inArray, lt } from "drizzle-orm";
import { customers, members, proposals } from "../schema/schema";
import type { ProposalItem } from "../schema/types";
import { db, newId } from "./db";
import type { DayPlan, PlanStop } from "./day-plan";
import { isLanguage, type Language } from "./language";
import { driveMinutes, driveSettingsOf, yardOf, type DriveSettings, type Place } from "./places";
import { getProfile } from "./profile";
import type { Poster } from "./quotes";
import { findAvailability, getVisit, type Slot, type Viewer, type VisitView } from "./scheduling";
import { dayText, intervalsOverlap, timeText, wallClock, type Interval } from "./scheduling-time";
import { addDays } from "./time";

export type Proposal = typeof proposals.$inferSelect;
type Deps = { now?: Date; post?: Poster };

const MINUTE = 60_000;
/** How many days past the crew's day a stop may move to, with the same crew. */
const LATER_DAYS = 14;

const plus = (at: Date, minutes: number) => new Date(at.getTime() + minutes * MINUTE);
const firstName = (name: string) => name.split(/\s+/)[0] ?? name;
const languageOf = (value: unknown): Language => (isLanguage(value) ? value : "en");
/** Ends a sentence once: Spanish clocks already end in "p.m.". */
const sentence = (text: string) => (text.endsWith(".") ? text : `${text}.`);

// ---------------------------------------------------------------------------------------------
// Which stops move

export type MoveContext = {
  now: Date;
  /** A stop the crew would reach within this many minutes stays: they're already on their way. */
  leadMinutes: number;
  /** The workday's end plus the grace: the latest the return may run. */
  latestBackAt: Date;
  yard: Place | null;
  settings: DriveSettings;
};

/**
 * When the crew are back with only the day's first `count` stops: the last one's projected leave plus the drive
 * back to the yard, or its leave when either end is unplaced (as `replanFrom` reckons it). Null with no stops.
 */
export function returnWith(plan: DayPlan, count: number, yard: Place | null, settings: DriveSettings): Date | null {
  const last = plan.stops[count - 1];
  if (!last) return null;
  return last.place && yard ? plus(last.plannedLeaveAt, driveMinutes(last.place, yard, settings)) : last.plannedLeaveAt;
}

/**
 * The stops to take off a day at risk, in day order. Pure. From the last stop back, each not yet started or done
 * comes off until the re-planned return fits `latestBackAt`. It stops at a stop the crew have reached, and at one
 * they'd reach within `leadMinutes` of now (by its booked start or its projected arrival, whichever is sooner),
 * which stays with everything before it. Taking stops off the end leaves the ones before as they were planned.
 */
export function stopsToMove(plan: DayPlan, ctx: MoveContext): PlanStop[] {
  const moved: PlanStop[] = [];
  const lead = ctx.now.getTime() + ctx.leadMinutes * MINUTE;
  let count = plan.stops.length;
  while (count > 0) {
    const back = returnWith(plan, count, ctx.yard, ctx.settings);
    if (!back || back <= ctx.latestBackAt) break;
    const stop = plan.stops[count - 1];
    if (stop.startedAt || stop.status === "completed") break;
    if (Math.min(stop.startAt.getTime(), stop.plannedArriveAt.getTime()) < lead) break;
    moved.unshift(stop);
    count--;
  }
  return moved;
}

// ---------------------------------------------------------------------------------------------
// Where each goes

/** A slot's time with the drives in and out: what it keeps its crew from. */
const heldBy = (slot: Slot): Interval => ({
  startAt: plus(slot.startAt, -(slot.driveFromPreviousMinutes ?? 0)),
  endAt: plus(slot.endAt, slot.driveToNextMinutes ?? 0),
});

/** Time already given to an earlier stop of the same proposal, by member. */
export type Claimed = Map<string, Interval[]>;

const clashes = (slot: Slot, claimed: Claimed) => slot.crew.some((c) => (claimed.get(c.memberId) ?? []).some((taken) => intervalsOverlap(heldBy(slot), taken)));

/**
 * The slot a stop moves to, from `findAvailability`'s slots in its ranked order (those that fit the day's capacity
 * first, then the least driving added). Pure. `today`: the first that fits on the crew's day with someone else,
 * starting no sooner than `earliest`. `later`: the first that fits on the earliest later day that has one. Either
 * way, never over time an earlier stop of the proposal was given.
 */
export function pickSlot(
  slots: Slot[],
  scope: "today" | "later",
  input: { memberId: string; date: string; earliest: Date; claimed: Claimed },
): Slot | null {
  const open = slots.filter((s) => s.fits && !clashes(s, input.claimed));
  if (scope === "today") {
    return open.find((s) => s.date === input.date && !s.crew.some((c) => c.memberId === input.memberId) && s.startAt >= input.earliest) ?? null;
  }
  const later = open.filter((s) => s.date > input.date);
  const day = later.map((s) => s.date).sort()[0];
  return later.find((s) => s.date === day) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Words

/** "today", "tomorrow", a weekday within the week ("Mon"), else the date ("Mon, Nov 16"), from the crew's day. */
export function dayWord(date: string, from: string, language: Language): string {
  if (date === from) return language === "es" ? "hoy" : "today";
  if (date === addDays(from, 1)) return language === "es" ? "mañana" : "tomorrow";
  if (date > from && date < addDays(from, 7)) {
    return new Intl.DateTimeFormat(language === "es" ? "es-US" : "en-US", { timeZone: "UTC", weekday: "short" }).format(new Date(`${date}T12:00:00Z`));
  }
  return dayText(date, language);
}

/** The names a list of people is said with: "Pat", "Pat and Ana". */
function namesText(names: string[], language: Language): string {
  const first = names.map(firstName);
  const and = language === "es" ? " y " : " and ";
  return first.length > 1 ? `${first.slice(0, -1).join(", ")}${and}${first.at(-1)}` : (first[0] ?? "");
}

/**
 * The reason, one line: "Carlos is running 40 min late at 412 Oak St; the day would end at 6:10 PM". The minutes
 * are how much later than booked the crew are back; the end is the re-planned return.
 */
export function proposalReason(plan: DayPlan, timeZone: string, language: Language): string {
  const name = firstName(plan.name);
  const minutes = Math.max(0, plan.replan?.shiftMinutes ?? 0);
  const end = plan.backAtYardAt ?? plan.stops.at(-1)?.plannedLeaveAt ?? null;
  const at = plan.replan?.title;
  const when = end ? timeText(end, timeZone, language) : null;
  if (language === "es") return `${name} va ${minutes} min tarde${at ? ` en ${at}` : ""}${when ? `; el día terminaría a las ${when}` : ""}`;
  return `${name} is running ${minutes} min late${at ? ` at ${at}` : ""}${when ? `; the day would end at ${when}` : ""}`;
}

/** A stop's move as the owner reads it: "40 Pine Ave → Pat today 2:30 PM". */
export function itemLine(item: ProposalItem, from: string, timeZone: string, language: Language): string {
  return `${item.title} → ${namesText(item.to.names, language)} ${dayWord(item.to.date, from, language)} ${timeText(new Date(item.to.startAt), timeZone, language)}`;
}

/**
 * The owners' numbered confirm: the reason, then "Move 2 stops for Carlos? 1. 40 Pine Ave → Pat today 2:30 PM
 * 2. 4 Elm Rd → Carlos Mon 9 AM. Reply the numbers to keep, 'all', or 'no'." with each stop on its own line.
 */
export function ownerText(proposal: Pick<Proposal, "date" | "reason" | "items">, memberName: string, timeZone: string, language: Language): string {
  const n = proposal.items.length;
  const name = firstName(memberName);
  const ask =
    language === "es"
      ? `¿Muevo ${n} ${n === 1 ? "parada" : "paradas"} de ${name}?`
      : `Move ${n} ${n === 1 ? "stop" : "stops"} for ${name}?`;
  const reply = language === "es" ? "Responde los números que quieres, 'todas' o 'no'." : "Reply the numbers to keep, 'all', or 'no'.";
  const lines = proposal.items.map((item) => `${item.id}. ${itemLine(item, proposal.date, timeZone, language)}`);
  return [`${proposal.reason}.`, ask, ...lines, reply].join("\n");
}

/** "today, 2:30 PM–3:30 PM", "Mon, Nov 9, 9 AM–10 AM": a window as a customer reads it. */
function windowText(startAt: Date, endAt: Date, from: string, timeZone: string, language: Language): string {
  const date = wallClock(startAt, timeZone).date;
  const day = date === from ? (language === "es" ? "hoy" : "today") : dayText(date, language);
  return `${day}, ${timeText(startAt, timeZone, language)}–${timeText(endAt, timeZone, language)}`;
}

/**
 * The draft for the customer, in their language: what changed and the new window, with no prices. Only the crew
 * changing says who comes instead.
 */
export function customerText(
  move: { title: string; from: { startAt: Date }; to: { startAt: Date; endAt: Date; names: string[] }; date: string },
  customer: { name: string | null; language: Language },
  business: string,
  timeZone: string,
): string {
  const lang = customer.language;
  const hi = customer.name ? (lang === "es" ? `Hola ${firstName(customer.name)}` : `Hi ${firstName(customer.name)}`) : lang === "es" ? "Hola" : "Hi";
  const window = windowText(move.to.startAt, move.to.endAt, move.date, timeZone, lang);
  if (move.to.startAt.getTime() === move.from.startAt.getTime()) {
    const who = namesText(move.to.names, lang);
    return lang === "es"
      ? `${hi}, le escribe ${business}. Su visita en ${move.title} sigue ${window}; irá ${who} de nuestro equipo.`
      : `${hi}, it's ${business}. Your visit at ${move.title} is still ${window}; ${who} from our crew will be there.`;
  }
  const fromDate = wallClock(move.from.startAt, timeZone).date;
  const was = `${fromDate === move.date ? (lang === "es" ? "hoy" : "today") : dayText(fromDate, lang)} ${lang === "es" ? "a las" : "at"} ${timeText(move.from.startAt, timeZone, lang)}`;
  return lang === "es"
    ? `${hi}, le escribe ${business}. Hoy vamos con retraso, así que movimos su visita en ${move.title} de ${was} a ${sentence(window)} Avísenos si ese horario no le funciona.`
    : `${hi}, it's ${business}. We're running behind today, so we've moved your visit at ${move.title} from ${was} to ${sentence(window)} Reply if that time doesn't work.`;
}

/** The line the receiving crew will be told: taking it over from the crew running late, or its new time. */
export function crewLine(move: { title: string; to: { startAt: Date; endAt: Date }; date: string; takesOver: string | null }, timeZone: string, language: Language): string {
  const window = windowText(move.to.startAt, move.to.endAt, move.date, timeZone, language);
  if (move.takesOver) {
    return language === "es" ? `Te toca ${move.title}: ${window}, en lugar de ${firstName(move.takesOver)}.` : `You're on ${move.title}: ${window}, in place of ${firstName(move.takesOver)}.`;
  }
  return sentence(language === "es" ? `${move.title} pasa a ${window}` : `${move.title} moves to ${window}`);
}

// ---------------------------------------------------------------------------------------------
// Building one

export type BuildContext = MoveContext & {
  timeZone: string;
  /** The business's name, for the customer drafts. */
  business: string;
  /** The business's language, which the reason is written in. */
  language: Language;
  /** Each stop's visit: its revision and crew, and its customer's name and language. */
  visits: Map<string, Pick<VisitView, "revision" | "crew" | "customerName" | "bufferBeforeMinutes" | "bufferAfterMinutes"> & { customerLanguage: Language }>;
  /** Each member's language, for the crew lines. */
  memberLanguages: Map<string, Language>;
  /** Slots for a stop: on the crew's day for anyone who carries what it needs, or with its own crew on later days. */
  slotsFor: (stop: PlanStop, scope: "today" | "later") => Promise<Slot[]>;
};

/**
 * A move proposal for a day at risk: the stops `stopsToMove` picks, each placed with `pickSlot` (someone else
 * today, from its booked time on, else its own crew on the next day that has room), with the drafts. Stops with nowhere to go stay off
 * it; null when none can move. Items are numbered in day order. Pure but for `slotsFor`.
 */
export async function buildMoveProposal(plan: DayPlan, ctx: BuildContext): Promise<{ reason: string; items: ProposalItem[] } | null> {
  const claimed: Claimed = new Map();
  const items: ProposalItem[] = [];
  for (const stop of stopsToMove(plan, ctx)) {
    const visit = ctx.visits.get(stop.visitId);
    if (!visit) continue;
    // Today, someone else takes it no sooner than its booked time (the customer expects them then) and the lead.
    const lead = plus(ctx.now, ctx.leadMinutes);
    const input = { memberId: plan.memberId, date: plan.date, earliest: stop.startAt > lead ? stop.startAt : lead, claimed };
    const slot = pickSlot(await ctx.slotsFor(stop, "today"), "today", input) ?? pickSlot(await ctx.slotsFor(stop, "later"), "later", input);
    if (!slot) continue;
    for (const c of slot.crew) claimed.set(c.memberId, [...(claimed.get(c.memberId) ?? []), heldBy(slot)]);
    const move = {
      title: stop.title,
      date: plan.date,
      from: { startAt: stop.startAt },
      to: { startAt: slot.startAt, endAt: slot.endAt, names: slot.crew.map((c) => c.name) },
    };
    const takesOver = slot.crew.some((c) => c.memberId === plan.memberId) ? null : plan.name;
    const receiver = slot.crew.find((c) => !visit.crew.some((v) => v.memberId === c.memberId)) ?? slot.crew[0];
    items.push({
      id: String(items.length + 1),
      visitId: stop.visitId,
      revision: visit.revision,
      title: stop.title,
      customerName: visit.customerName,
      from: { startAt: stop.startAt.toISOString(), endAt: stop.endAt.toISOString(), memberIds: visit.crew.map((c) => c.memberId) },
      to: {
        startAt: slot.startAt.toISOString(),
        endAt: slot.endAt.toISOString(),
        date: slot.date,
        time: slot.start,
        offsetMinutes: slot.offsetMinutes,
        memberIds: slot.crew.map((c) => c.memberId),
        names: slot.crew.map((c) => c.name),
        bufferBeforeMinutes: slot.driveFromPreviousMinutes ?? visit.bufferBeforeMinutes,
        bufferAfterMinutes: slot.driveToNextMinutes ?? visit.bufferAfterMinutes,
      },
      customerText: customerText(move, { name: visit.customerName, language: visit.customerLanguage }, ctx.business, ctx.timeZone),
      crewText: crewLine({ ...move, takesOver }, ctx.timeZone, ctx.memberLanguages.get(receiver.memberId) ?? "en"),
    });
  }
  return items.length ? { reason: proposalReason(plan, ctx.timeZone, ctx.language), items } : null;
}

// ---------------------------------------------------------------------------------------------
// Raising one

/** Everyone's view of the business, as the checks read it; nobody is acting. */
const businessViewer = (orgId: string): Viewer => ({ orgId, memberId: null, role: "owner" });

/**
 * Raises a move proposal for a day at risk, once per member and day: none when the day isn't today, one was
 * raised for it already (decided or not), or no stop can move. Returns the proposal stored.
 */
export async function proposeMoves(orgId: string, plan: DayPlan, deps?: Deps): Promise<Proposal | null> {
  const now = deps?.now ?? plan.replan?.at ?? new Date();
  const profile = await getProfile(orgId);
  const timeZone = profile.timeZone;
  const latestBackAt = plan.replan?.latestBackAt;
  if (!latestBackAt || plan.date !== wallClock(now, timeZone).date) return null;
  const [raised] = await db()
    .select({ id: proposals.id })
    .from(proposals)
    .where(and(eq(proposals.orgId, orgId), eq(proposals.kind, "move_stops"), eq(proposals.memberId, plan.memberId), eq(proposals.date, plan.date)))
    .limit(1);
  if (raised) return null;
  const viewer = businessViewer(orgId);
  const views = (await Promise.all(plan.stops.map((s) => getVisit(viewer, s.visitId)))).filter((v): v is VisitView => v !== null);
  const customerIds = [...new Set(views.flatMap((v) => (v.customerId ? [v.customerId] : [])))];
  const customerRows = customerIds.length
    ? await db().select({ id: customers.id, language: customers.language }).from(customers).where(and(eq(customers.orgId, orgId), inArray(customers.id, customerIds)))
    : [];
  const memberRows = await db().select({ id: members.id, language: members.language }).from(members).where(eq(members.orgId, orgId));
  const built = await buildMoveProposal(plan, {
    now,
    leadMinutes: profile.leadMinutes,
    latestBackAt,
    yard: yardOf(profile),
    settings: driveSettingsOf(profile),
    timeZone,
    business: profile.name,
    language: languageOf(profile.language),
    visits: new Map(
      views.map((v) => [v.visitId, { ...v, customerLanguage: languageOf(customerRows.find((c) => c.id === v.customerId)?.language) }]),
    ),
    memberLanguages: new Map(memberRows.map((m) => [m.id, languageOf(m.language)])),
    slotsFor: async (stop, scope) => {
      const visit = views.find((v) => v.visitId === stop.visitId);
      if (!visit) return [];
      const found = await findAvailability(
        viewer,
        {
          ...(scope === "later" ? { memberIds: visit.crew.map((c) => c.memberId) } : {}),
          from: scope === "today" ? plan.date : addDays(plan.date, 1),
          days: scope === "today" ? 1 : LATER_DAYS,
          durationMinutes: Math.round((stop.endAt.getTime() - stop.startAt.getTime()) / MINUTE),
          reschedulingVisitId: stop.visitId,
          limit: 100,
        },
        { now },
      );
      return found.slots;
    },
  });
  if (!built) return null;
  const [stored] = await db()
    .insert(proposals)
    .values({ id: newId("prop"), orgId, kind: "move_stops", memberId: plan.memberId, date: plan.date, reason: built.reason, items: built.items, createdAt: now })
    .onConflictDoNothing()
    .returning();
  return stored ?? null;
}

/** Marks open proposals whose day is over expired, for one business; returns how many. */
export async function expireProposals(orgId: string, now: Date = new Date()): Promise<number> {
  const today = wallClock(now, (await getProfile(orgId)).timeZone).date;
  const rows = await db()
    .update(proposals)
    .set({ status: "expired", decidedAt: now })
    .where(and(eq(proposals.orgId, orgId), eq(proposals.status, "open"), lt(proposals.date, today)))
    .returning({ id: proposals.id });
  return rows.length;
}

// Proposals: a change the code works out and an owner or admin decides. Two kinds. `move_stops`: a crew member's
// day re-planned from now runs past its end plus the grace (`core/running-long.ts`), so the code picks their last
// stops not yet started and where each could go. `move_weather`: rain or heat is likely over tomorrow's
// weather-sensitive stops (`core/weather-check.ts`), so each moves to its crew's next dry day with room. Either
// way the owners get it as a numbered confirm by text and on the Schedule page. Nothing moves until they apply it, and applying re-checks every stop in one
// transaction; the stops that still hold move through the code `reschedule_visit` uses, and the crew are texted
// as they are for any move. Nothing here reaches a customer: each stop's customer text is a draft the owner
// forwards. Every time, choice, and check is made here; the assistant only relays the texts.
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { customers, followups, members, proposals } from "../schema/schema";
import type { ProposalItem } from "../schema/types";
import { db, newId, type Db, type Tx } from "./db";
import type { DayPlan, PlanStop } from "./day-plan";
import { isLanguage, type Language } from "./language";
import { isPrivileged, privilegedMembers } from "./members";
import { postToMember } from "./outbound";
import { driveMinutes, driveSettingsOf, yardOf, type DriveSettings, type Place } from "./places";
import { queueNotice } from "./followups";
import { getProfile, getProfileWith } from "./profile";
import type { Poster } from "./quotes";
import { findAvailability, getVisit, lockSchedule, moveVisitIn, tellMoved, type Actor, type Slot, type Viewer, type VisitView } from "./scheduling";
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

/** Gives a slot's time, its drives included, to its crew, so a later stop of the same proposal can't take it. */
export function claimSlot(claimed: Claimed, slot: Slot): void {
  for (const c of slot.crew) claimed.set(c.memberId, [...(claimed.get(c.memberId) ?? []), heldBy(slot)]);
}

/** Where an item moves to: the slot's day, clock, and crew, and its drives as the buffers (the visit's own when unknown). */
export function slotTarget(slot: Slot, visit: Pick<VisitView, "bufferBeforeMinutes" | "bufferAfterMinutes">): ProposalItem["to"] {
  return {
    startAt: slot.startAt.toISOString(),
    endAt: slot.endAt.toISOString(),
    date: slot.date,
    time: slot.start,
    offsetMinutes: slot.offsetMinutes,
    memberIds: slot.crew.map((c) => c.memberId),
    names: slot.crew.map((c) => c.name),
    bufferBeforeMinutes: slot.driveFromPreviousMinutes ?? visit.bufferBeforeMinutes,
    bufferAfterMinutes: slot.driveToNextMinutes ?? visit.bufferAfterMinutes,
  };
}

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
  // How late the crew are at the stop they're on: its projected leave past its booked end. The day's shift when
  // no stop is under way (a delay declared on the way).
  const current = plan.stops.find((s) => s.visitId === plan.replan?.visitId);
  const minutes = Math.max(0, current ? Math.round((current.plannedLeaveAt.getTime() - current.endAt.getTime()) / 60_000) : (plan.replan?.shiftMinutes ?? 0));
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
 * The day a proposal's moves are named from: its own day for one made that day, the evening before for a weather
 * one (made the evening before its day, so the next day after it is a weekday, never "tomorrow").
 */
export function linesFrom(proposal: Pick<Proposal, "date"> & { kind?: Proposal["kind"] }): string {
  return proposal.kind === "move_weather" ? addDays(proposal.date, -1) : proposal.date;
}

/**
 * The owners' numbered confirm: the reason, then "Move 2 stops for Carlos? 1. 40 Pine Ave → Pat today 2:30 PM
 * 2. 4 Elm Rd → Carlos Mon 9 AM. Reply the numbers to keep, 'all', or 'no'." with each stop on its own line. A
 * weather proposal asks "Move 3 stops to a dry day?".
 */
export function ownerText(
  proposal: Pick<Proposal, "date" | "reason" | "items"> & { kind?: Proposal["kind"] },
  memberName: string | null,
  timeZone: string,
  language: Language,
): string {
  const n = proposal.items.length;
  const stops = language === "es" ? `${n} ${n === 1 ? "parada" : "paradas"}` : `${n} ${n === 1 ? "stop" : "stops"}`;
  const ask =
    proposal.kind === "move_weather"
      ? language === "es"
        ? `¿Muevo ${stops} a un día seco?`
        : `Move ${stops} to a dry day?`
      : language === "es"
        ? `¿Muevo ${stops} de ${firstName(memberName ?? "")}?`
        : `Move ${stops} for ${firstName(memberName ?? "")}?`;
  const reply = language === "es" ? "Responde los números que quieres, 'todas' o 'no'." : "Reply the numbers to keep, 'all', or 'no'.";
  const lines = proposal.items.map((item) => `${item.id}. ${itemLine(item, linesFrom(proposal), timeZone, language)}`);
  return [`${proposal.reason}.`, ask, ...lines, reply].join("\n");
}

/** "today, 2:30 PM–3:30 PM", "Mon, Nov 9, 9 AM–10 AM": a window as a customer reads it. */
function windowText(startAt: Date, endAt: Date, from: string, timeZone: string, language: Language): string {
  const date = wallClock(startAt, timeZone).date;
  const day = date === from ? (language === "es" ? "hoy" : "today") : dayText(date, language);
  return `${day}, ${timeText(startAt, timeZone, language)}–${timeText(endAt, timeZone, language)}`;
}

/**
 * The draft for the customer, in their language: what changed and why (running behind, or rain or heat likely),
 * and the new window, with no prices. Only the crew changing says who comes instead.
 */
export function customerText(
  move: { title: string; from: { startAt: Date }; to: { startAt: Date; endAt: Date; names: string[] }; date: string; cause?: "late" | "rain" | "heat" },
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
  if (move.cause === "rain" || move.cause === "heat") {
    // The visit's own day by date: the customer reads it the evening before, or that morning.
    const day = `${dayText(fromDate, lang)} ${lang === "es" ? "a las" : "at"} ${timeText(move.from.startAt, timeZone, lang)}`;
    const why =
      lang === "es" ? (move.cause === "rain" ? "Como se espera lluvia" : "Como se espera mucho calor") : move.cause === "rain" ? "With rain likely" : "With high heat expected";
    return lang === "es"
      ? `${hi}, le escribe ${business}. ${why}, movimos su visita en ${move.title} de ${day} a ${sentence(window)} Avísenos si ese horario no le funciona.`
      : `${hi}, it's ${business}. ${why}, we've moved your visit at ${move.title} from ${day} to ${sentence(window)} Reply if that time doesn't work.`;
  }
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
    claimSlot(claimed, slot);
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
      to: slotTarget(slot, visit),
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
    .where(and(eq(proposals.orgId, orgId), eq(proposals.kind, "move_stops"), eq(proposals.memberId, plan.memberId), eq(proposals.date, plan.date), eq(proposals.status, "open")))
    .limit(1);
  // One open question at a time per crew and day; once it's answered, a day that runs long again can ask again.
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

/**
 * Texts the proposal to every active owner and admin in their language (the reason stays in the business's, as
 * stored). Proactive, so quiet hours hold it. A running-long one isn't queued for the morning, since its day
 * ends with it (it's on the Schedule page); a weather one, about the next day, is queued for when quiet hours end.
 * Returns who got it now.
 */
export async function sendProposal(orgId: string, proposal: Proposal, deps?: Deps): Promise<string[]> {
  const now = deps?.now ?? new Date();
  const memberId = proposal.memberId;
  const [profile, [crew]] = await Promise.all([
    getProfile(orgId),
    memberId ? db().select({ name: members.name }).from(members).where(and(eq(members.orgId, orgId), eq(members.id, memberId))) : Promise.resolve([]),
  ]);
  const sent: string[] = [];
  for (const owner of await privilegedMembers(orgId)) {
    const language = languageOf(owner.language);
    const text = ownerText(proposal, crew?.name ?? null, profile.timeZone, language);
    try {
      const result = await (deps?.post ?? postToMember)(orgId, owner.id, { text }, "proactive", { now, profile });
      if (result.posted) sent.push(owner.name);
      else if (result.reason === "quiet_hours" && proposal.kind === "move_weather") {
        await queueNotice({ orgId, memberId: owner.id, quoteId: null, payload: { text, asksApproval: false, proposalId: proposal.id }, now });
      }
    } catch (error) {
      console.error("proposals: the owner's text failed", { orgId, proposalId: proposal.id, error });
    }
  }
  return sent;
}

/**
 * Cancels the owners' texts about these proposals still queued behind quiet hours: once a proposal is decided or
 * over, a text asking about it would be answered about another.
 */
async function cancelQueuedTexts(executor: Db | Tx, orgId: string, proposalIds: string[]): Promise<void> {
  if (!proposalIds.length) return;
  await executor
    .update(followups)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(followups.orgId, orgId),
        eq(followups.kind, "notice"),
        eq(followups.status, "pending"),
        inArray(sql`${followups.payload}->>'proposalId'`, proposalIds),
      ),
    );
}

/** Marks open proposals whose day is over expired, for one business, and cancels their queued texts; returns how many. */
export async function expireProposals(orgId: string, now: Date = new Date()): Promise<number> {
  const today = wallClock(now, (await getProfile(orgId)).timeZone).date;
  const rows = await db()
    .update(proposals)
    .set({ status: "expired", decidedAt: now })
    .where(and(eq(proposals.orgId, orgId), eq(proposals.status, "open"), lt(proposals.date, today)))
    .returning({ id: proposals.id });
  await cancelQueuedTexts(db(), orgId, rows.map((row) => row.id));
  return rows.length;
}

// ---------------------------------------------------------------------------------------------
// Reading and deciding

/** An open proposal, with its crew member's name; null for a weather one, which is the business's. */
export type OpenProposal = Proposal & { memberName: string | null };

/** The open proposals of today and on, newest first. Owners and admins only; crew get none. */
export async function openProposals(viewer: Viewer, deps?: { now?: Date }): Promise<{ timeZone: string; proposals: OpenProposal[] }> {
  const { timeZone } = await getProfile(viewer.orgId);
  if (!isPrivileged(viewer.role)) return { timeZone, proposals: [] };
  const today = wallClock(deps?.now ?? new Date(), timeZone).date;
  const rows = await db()
    .select({ proposal: proposals, memberName: members.name })
    .from(proposals)
    .leftJoin(members, and(eq(members.orgId, viewer.orgId), eq(members.id, proposals.memberId)))
    .where(and(eq(proposals.orgId, viewer.orgId), eq(proposals.status, "open"), gte(proposals.date, today)))
    .orderBy(desc(proposals.createdAt), asc(proposals.id));
  return { timeZone, proposals: rows.map(({ proposal, memberName }) => ({ ...proposal, memberName })) };
}

/** A proposal as tools return it: its stops numbered as the owners' text has them, and that text. */
export function proposalForTool(proposal: OpenProposal, timeZone: string, language: Language) {
  return {
    proposalId: proposal.id,
    kind: proposal.kind,
    ...(proposal.memberName ? { crew: proposal.memberName } : {}),
    date: proposal.date,
    reason: proposal.reason,
    items: proposal.items.map((item) => ({ itemId: item.id, title: item.title, customerName: item.customerName, line: itemLine(item, linesFrom(proposal), timeZone, language) })),
    text: ownerText(proposal, proposal.memberName, timeZone, language),
  };
}

/**
 * The open proposal meant, locked for this transaction: the one named, else the only one open from today on.
 * Throws `PROPOSAL_NOT_FOUND`, `PROPOSAL_CLOSED` (decided or expired), `PROPOSAL_EXPIRED` (its day is over), or
 * `PROPOSAL_REQUIRED` (more than one is open and none was named).
 */
async function openProposalFor(tx: Tx, orgId: string, proposalId: string | undefined, today: string): Promise<Proposal> {
  const rows = await tx
    .select()
    .from(proposals)
    .where(and(eq(proposals.orgId, orgId), proposalId ? eq(proposals.id, proposalId) : and(eq(proposals.status, "open"), gte(proposals.date, today))))
    .orderBy(desc(proposals.createdAt))
    .limit(2)
    .for("update");
  const [proposal] = rows;
  if (!proposal) throw new Error("PROPOSAL_NOT_FOUND");
  if (rows.length > 1) throw new Error("PROPOSAL_REQUIRED");
  if (proposal.status !== "open") throw new Error(`PROPOSAL_CLOSED: it was ${proposal.status}`);
  if (proposal.date < today) throw new Error("PROPOSAL_EXPIRED");
  return proposal;
}

const SKIPPED: Record<Language, Record<string, string>> = {
  en: {
    REVISION_CHANGED: "it changed since the proposal",
    VISIT_NOT_OPEN: "it's done or cancelled",
    VISIT_NOT_FOUND: "it's done or cancelled",
    JOB_CLOSED: "its work is closed",
    CREW_BUSY: "that time isn't free anymore",
    CREW_OFF: "the crew are off then",
    OUTSIDE_HOURS: "that's outside working hours now",
    MISSING_EQUIPMENT: "the crew don't carry what it needs",
    MEMBER_NOT_FOUND: "that crew member isn't on the team anymore",
    VISIT_IN_PAST: "that time has passed",
    other: "it couldn't be moved",
  },
  es: {
    REVISION_CHANGED: "cambió desde la propuesta",
    VISIT_NOT_OPEN: "ya está hecha o cancelada",
    VISIT_NOT_FOUND: "ya está hecha o cancelada",
    JOB_CLOSED: "su trabajo está cerrado",
    CREW_BUSY: "ese horario ya no está libre",
    CREW_OFF: "el equipo no trabaja ese día",
    OUTSIDE_HOURS: "ya queda fuera del horario de trabajo",
    MISSING_EQUIPMENT: "el equipo no lleva lo que necesita",
    MEMBER_NOT_FOUND: "esa persona ya no está en el equipo",
    VISIT_IN_PAST: "esa hora ya pasó",
    other: "no se pudo mover",
  },
};

const skipReason = (error: unknown, language: Language) => {
  const code = (error instanceof Error ? error.message : "").split(":")[0];
  return SKIPPED[language][code] ?? SKIPPED[language].other;
};

export type Applied = {
  proposal: Proposal;
  moved: Array<{ itemId: string; title: string; line: string }>;
  skipped: Array<{ itemId: string; title: string; reason: string }>;
  /** Drafts for the owner to forward to the customers of the stops that moved; nothing was sent to them. */
  customerTexts: Array<{ itemId: string; customerName: string | null; text: string }>;
  /** Whom the moves texted: the crew, as any move does. */
  notified: string[];
  summaryText: string;
};

/**
 * Applies a proposal: all its stops, or the `itemIds` the owner kept. Owners and admins only. One transaction
 * holds the schedule's lock and re-checks each stop as it moves: the visit is at the revision it was proposed
 * on (anything since, a start or a delay included, means it changed), its new time is still free for the crew
 * getting it, inside their hours, and they carry what the work needs (`moveVisitIn`, as `reschedule_visit`). A
 * stop that doesn't hold is skipped with why, and the rest still move. The proposal is applied either way. The
 * crew are texted once it commits.
 */
export async function applyProposal(actor: Actor, input: { proposalId?: string; itemIds?: string[] }, deps?: Deps): Promise<Applied> {
  if (!isPrivileged(actor.role)) throw new Error("NOT_PRIVILEGED");
  const { orgId, language } = actor;
  const now = deps?.now ?? new Date();
  const result = await db().transaction(async (tx) => {
    await lockSchedule(tx, orgId);
    const timeZone = (await getProfileWith(orgId, tx)).timeZone;
    const proposal = await openProposalFor(tx, orgId, input.proposalId, wallClock(now, timeZone).date);
    const wanted = input.itemIds ? [...new Set(input.itemIds.map((id) => id.trim()))] : proposal.items.map((item) => item.id);
    const items = wanted.map((id) => {
      const item = proposal.items.find((i) => i.id === id);
      if (!item) throw new Error(`PROPOSAL_ITEM_NOT_FOUND: ${id}`);
      return item;
    });
    const moved: Array<{ item: ProposalItem; previous: VisitView }> = [];
    const skipped: Array<{ item: ProposalItem; reason: string }> = [];
    for (const item of items) {
      try {
        // Each stop in its own savepoint, so one that doesn't hold leaves the others as they moved.
        const { previous } = await tx.transaction((sp) =>
          moveVisitIn(
            sp,
            actor,
            {
              visitId: item.visitId,
              revision: item.revision,
              day: item.to.date,
              time: item.to.time,
              offsetMinutes: item.to.offsetMinutes,
              memberIds: item.to.memberIds,
              bufferBeforeMinutes: item.to.bufferBeforeMinutes,
              bufferAfterMinutes: item.to.bufferAfterMinutes,
              reason: proposal.reason,
            },
            now,
          ),
        );
        moved.push({ item, previous });
      } catch (error) {
        skipped.push({ item, reason: skipReason(error, language) });
      }
    }
    const [decided] = await tx
      .update(proposals)
      .set({ status: "applied", decidedAt: now, decidedByMemberId: actor.memberId, appliedItemIds: moved.map((m) => m.item.id) })
      .where(and(eq(proposals.orgId, orgId), eq(proposals.id, proposal.id)))
      .returning();
    await cancelQueuedTexts(tx, orgId, [proposal.id]);
    return { proposal: decided, moved, skipped, timeZone };
  });
  const notified: string[] = [];
  for (const { previous } of result.moved) {
    try {
      notified.push(...(await tellMoved(actor, previous, result.timeZone, deps)).notified);
    } catch (error) {
      console.error("proposals: a moved stop's crew text failed", { orgId, visitId: previous.visitId, error });
    }
  }
  const moved = result.moved.map(({ item }) => ({ itemId: item.id, title: item.title, line: itemLine(item, linesFrom(result.proposal), result.timeZone, language) }));
  const skipped = result.skipped.map(({ item, reason }) => ({ itemId: item.id, title: item.title, reason }));
  const customerTexts = result.moved.map(({ item }) => ({ itemId: item.id, customerName: item.customerName, text: item.customerText }));
  return { proposal: result.proposal, moved, skipped, customerTexts, notified: [...new Set(notified)], summaryText: summaryText({ moved, skipped, customerTexts, notified: [...new Set(notified)] }, language) };
}

/**
 * What applying did, for the owner: "Moved 2 stops: 40 Pine Ave → Pat today 2:30 PM; 4 Elm Rd → Carlos Mon 9 AM.
 * The crew are texted." then what didn't move and why, then each customer's draft to forward.
 */
export function summaryText(result: Pick<Applied, "moved" | "skipped" | "customerTexts"> & { notified?: string[] }, language: Language): string {
  const es = language === "es";
  const n = result.moved.length;
  const lines: string[] = [];
  if (n) {
    const stops = es ? (n === 1 ? "1 parada" : `${n} paradas`) : n === 1 ? "1 stop" : `${n} stops`;
    // "The crew are texted" only when someone was: a member who hasn't texted the line yet gets nothing.
    const texted = result.notified === undefined || result.notified.length > 0 ? ` ${es ? "El equipo ya tiene el mensaje." : "The crew are texted."}` : "";
    lines.push(`${es ? "Moví" : "Moved"} ${stops}: ${result.moved.map((m) => m.line).join("; ")}.${texted}`);
  } else {
    lines.push(es ? "No se movió nada." : "Nothing moved.");
  }
  if (result.skipped.length) {
    lines.push(`${es ? "Sin mover" : "Not moved"}: ${result.skipped.map((s) => `${s.title} (${s.reason})`).join("; ")}.`);
  }
  if (result.customerTexts.length) {
    lines.push(es ? "Mensajes para los clientes, para que los reenvíes:" : "Texts for the customers, for you to forward:");
    for (const draft of result.customerTexts) lines.push(`${draft.customerName ?? (es ? "Cliente" : "Customer")}: ${draft.text}`);
  }
  return lines.join("\n\n");
}

/** Drops a proposal: nothing moves. Owners and admins only. */
export async function dropProposal(actor: Actor, input: { proposalId?: string }, deps?: { now?: Date }): Promise<{ proposal: Proposal; summaryText: string }> {
  if (!isPrivileged(actor.role)) throw new Error("NOT_PRIVILEGED");
  const now = deps?.now ?? new Date();
  const proposal = await db().transaction(async (tx) => {
    const timeZone = (await getProfileWith(actor.orgId, tx)).timeZone;
    const open = await openProposalFor(tx, actor.orgId, input.proposalId, wallClock(now, timeZone).date);
    const [dropped] = await tx
      .update(proposals)
      .set({ status: "dropped", decidedAt: now, decidedByMemberId: actor.memberId })
      .where(and(eq(proposals.orgId, actor.orgId), eq(proposals.id, open.id), eq(proposals.status, "open")))
      .returning();
    await cancelQueuedTexts(tx, actor.orgId, [open.id]);
    return dropped;
  });
  const n = proposal.items.length;
  const summary =
    actor.language === "es"
      ? `Listo, no muevo nada: ${n === 1 ? "la parada se queda" : `las ${n} paradas se quedan`} como están.`
      : `OK, nothing moves: ${n === 1 ? "the stop stays" : `the ${n} stops stay`} as booked.`;
  return { proposal, summaryText: summary };
}


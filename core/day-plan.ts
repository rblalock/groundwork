// A crew member's day as a route: their visits that day in booked order, the drive into each from the stop
// before or the yard, when they leave the yard and get back, and how full the day is against the business's
// capacity. Derived every time from the visits and never saved: the visits are the record, and nothing here
// changes one or reaches a customer. Every time and minute is worked out here, in whole minutes; the
// assistant only says them.
//
// v1 keeps the booked order, since visits have times. It suggests a shorter one (`core/route-order.ts`) when
// that drives at least `SUGGEST_SAVES_MINUTES` less; applying it is for later.
//
// Today's plan re-plans from now (`replanFrom`) once the crew are under way: a stop they're on, one marked
// done, or a delay they declared moves the stops after it, and the day is at risk when it's running long and
// the return runs past the workday's end by more than the business's grace.
import { isPrivileged } from "./members";
import { driveMinutes, driveSettingsOf, yardOf, type DriveSettings, type Leg, type Place } from "./places";
import { getProfile, type Profile } from "./profile";
import { routeDriveMinutes, suggestOrder } from "./route-order";
import { readSchedule, scheduleCrew, type ScheduleWindow, type Viewer, type VisitStatus, type VisitView } from "./scheduling";
import { dayText, minutesClock, resolveLocalTime, timeText, wallClock, workingSegments, type WorkingInterval } from "./scheduling-time";
import { addDays } from "./time";
import type { Language } from "./language";

/** A suggested order is shown only when it saves at least this much driving. */
export const SUGGEST_SAVES_MINUTES = 10;
const MINUTE = 60_000;

export type PlanStop = {
  visitId: string;
  title: string;
  address: string | null;
  place: Place | null;
  status: VisitStatus;
  checklist: { done: number; total: number } | null;
  /** When the crew said they were on site, and when it was marked done; null until then. */
  startedAt: Date | null;
  completedAt: Date | null;
  /** A delay the crew declared on it, in minutes. */
  delayMinutes: number;
  /** The drive in from the stop before or the yard; null when either end is unplaced. */
  legIn: Leg | null;
  /** When the crew get there leaving the stop before as it ends (the first: its start). Re-planned: projected. */
  plannedArriveAt: Date;
  startAt: Date;
  endAt: Date;
  /** When they're done and leave: its end, later when they arrive late. Re-planned: projected. */
  plannedLeaveAt: Date;
  /** How many minutes after its start they'd get there; 0 on time. */
  lateMinutes: number;
};

/** How a day re-planned from now (`replanFrom`). */
export type Replan = {
  at: Date;
  /** The stop under way or running late, when there is one. */
  visitId: string | null;
  title: string | null;
  /** How many minutes later than booked the crew are back (or leave the last stop, without a placed yard). */
  shiftMinutes: number;
  /** The stop under way is `lateAfterMinutes` past its finish and not done, or the crew declared a delay. */
  runningLong: boolean;
  bookedBackAtYardAt: Date | null;
  /** The end of the member's workday; null on a day with no hours. */
  dayEndAt: Date | null;
  /** The workday's end plus the grace: the latest the return may run before the day is at risk. */
  latestBackAt: Date | null;
};

export type DayPlan = {
  memberId: string;
  name: string;
  date: string;
  stops: PlanStop[];
  /** The drive from the last stop back to the yard; null when either end is unplaced. */
  legOut: Leg | null;
  /** The first start less the drive in; null when that drive is unknown. */
  leaveYardAt: Date | null;
  /** The last planned leave plus the drive back; null when that drive is unknown. */
  backAtYardAt: Date | null;
  /** The legs that could be worked out, in and back. */
  driveMinutes: number;
  workMinutes: number;
  /** The member's working hours that day. */
  dayMinutes: number;
  /** Work plus driving over the working day, in basis points; null on a day with no working hours. */
  load: number | null;
  capacityBp: number;
  overCapacity: boolean;
  /** Titles of stops left out of drive math because their address couldn't be placed. */
  unplaced: string[];
  yardPlaced: boolean;
  /** A shorter order, when it drives `SUGGEST_SAVES_MINUTES` or more less than the booked one; else null. */
  suggestedOrder: Array<{ visitId: string; title: string }> | null;
  savedDriveMinutes: number | null;
  /** Set on today's plan once it re-planned from now; null on the booked plan. */
  replan: Replan | null;
  /** Running long, and back past the workday's end plus the grace, later than booked. */
  atRisk: boolean;
};

export type PlanInput = {
  memberId: string;
  name: string;
  date: string;
  /** The member's working hours (their own or the business's). */
  hours: WorkingInterval[];
  yard: Place | null;
  settings: DriveSettings;
  capacityBp: number;
  /** The member's visits that day; cancelled ones are left out. */
  visits: VisitView[];
};

const minutesBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / MINUTE);
const plus = (at: Date, minutes: number) => new Date(at.getTime() + minutes * MINUTE);

/** One member's day as a route. Pure: the visits, hours, yard, and settings in; the plan out. */
export function planDay(input: PlanInput): DayPlan {
  const { yard, settings } = input;
  const visits = input.visits.filter((v) => v.status !== "cancelled").sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || a.visitId.localeCompare(b.visitId));
  const stops: PlanStop[] = [];
  let from: Place | null = yard;
  let previous: PlanStop | null = null;
  for (const v of visits) {
    const legIn: Leg | null = from && v.place ? { minutes: driveMinutes(from, v.place, settings), label: from.label, yard: previous === null } : null;
    const plannedArriveAt = previous && legIn ? plus(previous.plannedLeaveAt, legIn.minutes) : v.startAt;
    const lateMinutes = Math.max(0, minutesBetween(v.startAt, plannedArriveAt));
    const stop: PlanStop = {
      visitId: v.visitId,
      title: v.title,
      address: v.address,
      place: v.place,
      status: v.status,
      checklist: v.checklist,
      startedAt: v.startedAt,
      completedAt: v.completedAt,
      delayMinutes: v.delayMinutes,
      legIn,
      plannedArriveAt,
      startAt: v.startAt,
      endAt: v.endAt,
      plannedLeaveAt: plus(v.endAt, lateMinutes),
      lateMinutes,
    };
    stops.push(stop);
    previous = stop;
    from = v.place;
  }
  const first = stops[0];
  const last = stops.at(-1);
  const legOut: Leg | null = last?.place && yard ? { minutes: driveMinutes(last.place, yard, settings), label: yard.label, yard: true } : null;
  const driveTotal = stops.reduce((sum, s) => sum + (s.legIn?.minutes ?? 0), 0) + (legOut?.minutes ?? 0);
  const workMinutes = stops.reduce((sum, s) => sum + minutesBetween(s.startAt, s.endAt), 0);
  const dayMinutes = workingSegments(input.date, input.hours).reduce((sum, s) => sum + (s.end - s.start), 0);
  const load = dayMinutes > 0 ? Math.round(((workMinutes + driveTotal) * 10_000) / dayMinutes) : null;
  const suggestion = suggest(stops, yard, settings);
  return {
    memberId: input.memberId,
    name: input.name,
    date: input.date,
    stops,
    legOut,
    leaveYardAt: first?.legIn ? plus(first.startAt, -first.legIn.minutes) : null,
    backAtYardAt: last && legOut ? plus(last.plannedLeaveAt, legOut.minutes) : null,
    driveMinutes: driveTotal,
    workMinutes,
    dayMinutes,
    load,
    capacityBp: input.capacityBp,
    overCapacity: load !== null && load > input.capacityBp,
    unplaced: stops.filter((s) => !s.place).map((s) => s.title),
    yardPlaced: yard !== null,
    suggestedOrder: suggestion?.order ?? null,
    savedDriveMinutes: suggestion?.saved ?? null,
    replan: null,
    atRisk: false,
  };
}

export type ReplanSettings = {
  /** A stop under way this many minutes past its finish counts as running long. */
  lateAfterMinutes: number;
  /** How far past the workday's end the return may run before the day is at risk. */
  graceMinutes: number;
  /** The end of the member's workday (`dayEndAt`); null on a day with no hours. */
  dayEndAt: Date | null;
};

const later = (a: Date, b: Date) => (a > b ? a : b);

/**
 * The day re-planned from `now`. Pure: the booked plan, the crew's starts, finishes, and delays in; the projected
 * plan out. Unchanged (`replan` null) until a stop is started, done, or has a delay.
 *
 * - A stop marked done left when it was marked done, and got there when it was started (else as planned).
 * - The stop under way (the last one started and not done, with nothing after it started) finishes at its start
 *   plus its length, plus a declared delay, and never before `now` while it isn't done. It's running long once
 *   `now` is `lateAfterMinutes` past that finish.
 * - Every stop after gets there when the one before finishes plus the drive (or at the one before's finish,
 *   unplaced), never before its booked start; a delay declared on a stop not yet started puts its arrival that
 *   many minutes after its booked start. `lateMinutes` is the projected arrival less the booked start.
 * - At risk: running long (or a delay), and the projected return passes the workday's end plus the grace, later
 *   than the booked return.
 */
export function replanFrom(plan: DayPlan, now: Date, settings: ReplanSettings): DayPlan {
  const touched = plan.stops.some((s) => s.startedAt || s.completedAt || s.status === "completed" || s.delayMinutes > 0);
  if (!touched) return { ...plan, replan: null, atRisk: false };
  const reached = plan.stops.findLastIndex((s) => s.startedAt || s.status === "completed");
  const underWay = reached >= 0 && plan.stops[reached].status !== "completed" ? reached : -1;
  let overdue = false;
  let leave: Date | null = null;
  const stops = plan.stops.map((s, i): PlanStop => {
    const length = minutesBetween(s.startAt, s.endAt);
    const chained: Date = leave === null ? s.plannedArriveAt : s.legIn ? plus(leave, s.legIn.minutes) : later(leave, s.startAt);
    let arrive: Date;
    let leaves: Date;
    if (s.status === "completed") {
      leaves = s.completedAt ?? plus(later(chained, s.startAt), length);
      arrive = s.startedAt ?? (chained < leaves ? chained : leaves);
    } else if (s.startedAt) {
      arrive = s.startedAt;
      const finish = plus(s.startedAt, length + s.delayMinutes);
      leaves = i === underWay ? later(finish, now) : finish;
      if (i === underWay && now.getTime() >= finish.getTime() + settings.lateAfterMinutes * MINUTE) overdue = true;
    } else {
      arrive = s.delayMinutes > 0 ? later(chained, plus(s.startAt, s.delayMinutes)) : chained;
      leaves = plus(later(arrive, s.startAt), length);
    }
    leave = leaves;
    return { ...s, plannedArriveAt: arrive, plannedLeaveAt: leaves, lateMinutes: Math.max(0, minutesBetween(s.startAt, arrive)) };
  });
  const delayed = stops.find((s) => s.status !== "completed" && s.delayMinutes > 0);
  const current = underWay >= 0 ? stops[underWay] : (delayed ?? null);
  const last = stops.at(-1)!;
  const backAtYardAt = plan.legOut ? plus(last.plannedLeaveAt, plan.legOut.minutes) : null;
  const bookedEnd = plan.backAtYardAt ?? plan.stops.at(-1)!.plannedLeaveAt;
  const projectedEnd = backAtYardAt ?? last.plannedLeaveAt;
  const shiftMinutes = minutesBetween(bookedEnd, projectedEnd);
  const runningLong = overdue || delayed !== undefined;
  const latestBackAt = settings.dayEndAt ? plus(settings.dayEndAt, settings.graceMinutes) : null;
  return {
    ...plan,
    stops,
    backAtYardAt,
    suggestedOrder: null,
    savedDriveMinutes: null,
    replan: {
      at: now,
      visitId: current?.visitId ?? null,
      title: current?.title ?? null,
      shiftMinutes,
      runningLong,
      bookedBackAtYardAt: plan.backAtYardAt,
      dayEndAt: settings.dayEndAt,
      latestBackAt,
    },
    atRisk: runningLong && latestBackAt !== null && projectedEnd > latestBackAt && shiftMinutes > 0,
  };
}

/** When the member's working hours end on `date`, in the business's time zone; null on a day off. */
export function dayEndAt(date: string, hours: WorkingInterval[], timeZone: string): Date | null {
  const last = workingSegments(date, hours).at(-1);
  if (!last) return null;
  try {
    return resolveLocalTime(date, minutesClock(Math.min(last.end, 23 * 60 + 59)), timeZone);
  } catch {
    return null;
  }
}

/** Today's plan re-planned from `now` with the business's settings; any other day's as booked. */
function replanned(plan: DayPlan, hours: WorkingInterval[], profile: Profile, now: Date): DayPlan {
  if (plan.date !== wallClock(now, profile.timeZone).date) return plan;
  return replanFrom(plan, now, {
    lateAfterMinutes: profile.lateAfterMinutes,
    graceMinutes: profile.dayEndGraceMinutes,
    dayEndAt: dayEndAt(plan.date, hours, profile.timeZone),
  });
}

/**
 * A shorter order for the day, when every stop and the yard are placed (so both totals are whole), nothing is
 * done yet (a day under way isn't reordered), and it saves enough to be worth saying.
 */
function suggest(stops: PlanStop[], yard: Place | null, settings: DriveSettings): { order: Array<{ visitId: string; title: string }>; saved: number } | null {
  if (!yard || stops.length < 3 || stops.some((s) => !s.place || s.status === "completed")) return null;
  const placed = stops as Array<PlanStop & { place: Place }>;
  const booked = routeDriveMinutes(yard, placed.map((s) => s.place), settings);
  const order = suggestOrder(yard, placed, settings);
  const saved = booked - routeDriveMinutes(yard, order.map((s) => s.place), settings);
  return saved >= SUGGEST_SAVES_MINUTES ? { order: order.map((s) => ({ visitId: s.visitId, title: s.title })), saved } : null;
}

/** Visits on the member's crew that start on the local day `date`. */
const visitsOf = (visits: VisitView[], memberId: string, date: string, timeZone: string) =>
  visits.filter((v) => v.crew.some((c) => c.memberId === memberId) && wallClock(v.startAt, timeZone).date === date);

/**
 * Each member's plan for each day of a schedule window that has visits for them, today's re-planned from `now`.
 * Owners and admins (and a super admin's look-only view) get everyone in the window; crew get only their own.
 */
export function plansIn(viewer: Viewer, schedule: ScheduleWindow, profile: Profile, now: Date = new Date()): DayPlan[] {
  const crew = isPrivileged(viewer.role) ? schedule.crew : schedule.crew.filter((c) => c.memberId === viewer.memberId);
  const yard = yardOf(profile);
  const settings = driveSettingsOf(profile);
  const plans: DayPlan[] = [];
  for (let date = schedule.from; date < schedule.to; date = addDays(date, 1)) {
    for (const member of crew) {
      const visits = visitsOf(schedule.visits, member.memberId, date, schedule.timeZone);
      if (visits.length === 0) continue;
      const plan = planDay({ memberId: member.memberId, name: member.name, date, hours: member.hours, yard, settings, capacityBp: profile.capacityBp, visits });
      plans.push(replanned(plan, member.hours, profile, now));
    }
  }
  return plans;
}

/** The plans for one day: everyone's for owners and admins (or one member's with `memberId`), a crew member's own. */
export async function dayPlans(viewer: Viewer, input: { date: string; memberId?: string }, deps?: { now?: Date }): Promise<{ timeZone: string; date: string; plans: DayPlan[] }> {
  const memberId = isPrivileged(viewer.role) ? input.memberId : (viewer.memberId ?? undefined);
  if (!isPrivileged(viewer.role) && !memberId) return { timeZone: (await getProfile(viewer.orgId)).timeZone, date: input.date, plans: [] };
  const [profile, schedule] = await Promise.all([getProfile(viewer.orgId), readSchedule(viewer, { from: input.date, days: 1, memberId }, deps)]);
  return { timeZone: schedule.timeZone, date: schedule.from, plans: plansIn(viewer, schedule, profile, deps?.now) };
}

/** One member's plan for `date` from the visits given (the morning line's, say); null when they aren't a member. */
export async function dayPlanFor(orgId: string, memberId: string, date: string, input: { profile: Profile; visits: VisitView[] }): Promise<DayPlan | null> {
  const member = (await scheduleCrew(orgId)).find((c) => c.memberId === memberId);
  if (!member) return null;
  const { profile } = input;
  return planDay({
    memberId,
    name: member.name,
    date,
    hours: member.hours,
    yard: yardOf(profile),
    settings: driveSettingsOf(profile),
    capacityBp: profile.capacityBp,
    visits: visitsOf(input.visits, memberId, date, profile.timeZone),
  });
}

// ---------------------------------------------------------------------------------------------
// Words

const ROUTE: Record<Language, { leave: (at: string) => string; back: (at: string) => string; late: (minutes: number) => string }> = {
  en: { leave: (at) => `leave the yard ${at}`, back: (at) => `back by ${at}`, late: (minutes) => `${minutes} min late` },
  es: { leave: (at) => `sales de la base ${at}`, back: (at) => `de vuelta a las ${at}`, late: (minutes) => `${minutes} min tarde` },
};

/**
 * The day as one line: "leave the yard 7:50 AM → 9 AM 412 Oak St (10 min) → 10:30 AM 7 Pine Ave (5 min) → back by
 * 12:10 PM". Each stop has its start, title, and the drive in; an unplaced one has no minutes, and the yard's
 * ends are left off when their drives are unknown.
 */
export function routeLine(plan: DayPlan, timeZone: string, language: Language): string {
  const copy = ROUTE[language];
  const parts: string[] = [];
  if (plan.leaveYardAt) parts.push(copy.leave(timeText(plan.leaveYardAt, timeZone, language)));
  for (const stop of plan.stops) {
    const drive = stop.legIn && stop.legIn.minutes > 0 ? ` (${stop.legIn.minutes} min)` : "";
    const late = plan.replan && stop.lateMinutes > 0 && !stop.startedAt && stop.status !== "completed" ? `, ${copy.late(stop.lateMinutes)}` : "";
    parts.push(`${timeText(stop.startAt, timeZone, language)} ${stop.title}${drive}${late}`);
  }
  if (plan.backAtYardAt) parts.push(copy.back(timeText(plan.backAtYardAt, timeZone, language)));
  return parts.join(" → ");
}

/** A plan as tools return it: local clocks, whole minutes, the load in percent, and its line ready to send. */
export function planForTool(plan: DayPlan, timeZone: string, language: Language) {
  const clock = (at: Date | null) => (at ? wallClock(at, timeZone).time : null);
  return {
    memberId: plan.memberId,
    name: plan.name,
    date: plan.date,
    leaveYardAt: clock(plan.leaveYardAt),
    backAtYardAt: clock(plan.backAtYardAt),
    driveMinutes: plan.driveMinutes,
    workMinutes: plan.workMinutes,
    loadPercent: plan.load === null ? null : Math.round(plan.load / 100),
    capacityPercent: Math.round(plan.capacityBp / 100),
    overCapacity: plan.overCapacity,
    ...(plan.stops.some((s) => s.lateMinutes > 0) ? { late: plan.stops.filter((s) => s.lateMinutes > 0).map((s) => ({ title: s.title, minutes: s.lateMinutes })) } : {}),
    ...(plan.unplaced.length ? { unplaced: plan.unplaced } : {}),
    ...(plan.suggestedOrder ? { suggestedOrder: plan.suggestedOrder.map((s) => s.title), savedDriveMinutes: plan.savedDriveMinutes } : {}),
    ...(plan.replan
      ? {
          replanned: {
            onStop: plan.replan.title,
            shiftMinutes: plan.replan.shiftMinutes,
            runningLong: plan.replan.runningLong,
            bookedBackAtYardAt: clock(plan.replan.bookedBackAtYardAt),
            dayEndsAt: clock(plan.replan.dayEndAt),
          },
          atRisk: plan.atRisk,
        }
      : {}),
    line: `${plan.name}, ${dayText(plan.date, language)}: ${routeLine(plan, timeZone, language)}`,
  };
}

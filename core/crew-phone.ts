// A crew member's day from their phone: "next" for the next stop with its address link, notes, and checklist;
// "here" or "on site" to start a stop; "running 30 late" to declare a delay. Each reads the member's day as it
// re-plans from now (`core/day-plan.ts`), and every time and minute in the replies is worked out here; the
// assistant sends `text` as it is. Nothing here reaches a customer or moves a visit.
import { ensureChecklist, checklistText } from "./checklist";
import { dayPlans, type DayPlan, type PlanStop } from "./day-plan";
import type { Language } from "./language";
import { isPrivileged } from "./members";
import { listNotes } from "./notes";
import { getVisit, setVisitDelay, startVisit, type Actor, type Viewer, type VisitView } from "./scheduling";
import { timeText, wallClock } from "./scheduling-time";

type Deps = { now?: Date };

/** A map link for an address, which opens Maps on an iPhone and the map on the web. */
export const mapsUrl = (address: string) => `https://maps.apple.com/?q=${encodeURIComponent(address)}`;

const isDone = (s: PlanStop) => s.status === "completed";
/** Done before its booked start: a later stop closed early, not where the crew have got to on the route. */
export const doneEarly = (s: Pick<PlanStop, "status" | "completedAt" | "startAt">) =>
  s.status === "completed" && s.completedAt !== null && s.completedAt < s.startAt;

/** The last stop the crew got to (started, or done in its turn), or -1. */
const reachedIndex = (plan: DayPlan) => plan.stops.findLastIndex((s) => s.startedAt || (isDone(s) && !doneEarly(s)));

/** The stop they're on: the last one reached, while it isn't done; -1 when there is none. */
export function underWayIndex(plan: DayPlan): number {
  const reached = reachedIndex(plan);
  return reached >= 0 && !isDone(plan.stops[reached]) ? reached : -1;
}

/** The next stop to go to: the first after the last one reached that isn't started or done; -1 when none is left. */
export function nextStopIndex(plan: DayPlan): number {
  for (let i = reachedIndex(plan) + 1; i < plan.stops.length; i++) {
    if (!plan.stops[i].startedAt && !isDone(plan.stops[i])) return i;
  }
  return -1;
}

/** The stop a delay is about: the one they're on, else the next. */
export function currentStopIndex(plan: DayPlan): number {
  const underWay = underWayIndex(plan);
  return underWay >= 0 ? underWay : nextStopIndex(plan);
}

/** The member's day today, re-planned from now; null when they have nothing on it. */
async function todayPlan(viewer: Viewer, memberId: string, now: Date): Promise<{ plan: DayPlan | null; timeZone: string }> {
  const { plans, timeZone } = await dayPlans(viewer, { date: "today", memberId }, { now });
  return { plan: plans.find((p) => p.memberId === memberId) ?? null, timeZone };
}

/** Whose day a visit is on for this caller: theirs when they're on it, else its first crew member's. */
const dayOwner = (caller: Pick<Actor, "memberId">, visit: Pick<VisitView, "crew">) =>
  visit.crew.some((c) => c.memberId === caller.memberId) ? caller.memberId : (visit.crew[0]?.memberId ?? caller.memberId);

/** Up to three site notes on the stop's property, its customer, or its quote, one line each. */
async function siteNotes(viewer: Viewer, visit: VisitView): Promise<string[]> {
  if (!visit.customerId && !visit.propertyId) return [];
  const notes = await listNotes(viewer, visit.customerId ? { customerId: visit.customerId, limit: 50 } : { propertyId: visit.propertyId ?? undefined, limit: 50 });
  return notes
    .filter((n) => n.kind === "note" && (n.propertyId ? n.propertyId === visit.propertyId : n.quoteId ? n.quoteId === visit.quoteId : true))
    .slice(0, 3)
    .map((n) => {
      const body = n.body.split("\n").map((line) => line.trim()).find(Boolean);
      return body ? `${n.title}: ${body.slice(0, 200)}` : n.title;
    });
}

/** The work's checklist as lines, made from its quote if need be; null without one, or when it can't be read. */
async function checklistLines(orgId: string, jobId: string, language: Language): Promise<string | null> {
  try {
    const items = await ensureChecklist(orgId, jobId);
    return items.length ? checklistText(items, language) : null;
  } catch (error) {
    console.error("crew phone: the checklist was left off the next stop", error);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Words

const WORDS = {
  en: {
    yard: "the yard",
    next: "Next",
    late: (at: string, minutes: number) => `about ${at}, ${minutes} min late`,
    drive: (minutes: number, from: string) => `About ${minutes} min from ${from}.`,
    notes: "Notes",
    siteNotes: "Site notes",
    last: (back: string | null) => `No more stops today.${back ? ` Back at the yard about ${back}.` : ""}`,
    started: (title: string, at: string, done: string) => `On site at ${title} since ${at}, done about ${done}.`,
    already: (title: string, at: string) => `${title} was already started at ${at}.`,
    thenNext: (line: string) => ` Next: ${line}.`,
    thenLast: " That's the last stop today.",
    stillOpen: (titles: string) => ` ${titles} isn't marked done yet.`,
    delay: (minutes: number, title: string) => `Noted: ${minutes} min late at ${title}.`,
    cleared: (title: string) => `Cleared the delay at ${title}.`,
    shift: (title: string, at: string, minutes: number) => `${title} about ${at} (${minutes} min late)`,
    shifts: (list: string) => ` Now: ${list}.`,
    holds: " The rest of the day holds.",
    back: (at: string) => ` Back at the yard about ${at}.`,
    atRisk: (end: string) => ` That's past the ${end} end of the day, so the day shows at risk on the schedule.`,
  },
  es: {
    yard: "la base",
    next: "Sigue",
    late: (at: string, minutes: number) => `como a las ${at}, ${minutes} min tarde`,
    drive: (minutes: number, from: string) => `Unos ${minutes} min desde ${from}.`,
    notes: "Notas",
    siteNotes: "Notas del sitio",
    last: (back: string | null) => `No hay más paradas hoy.${back ? ` De vuelta a la base como a las ${back}.` : ""}`,
    started: (title: string, at: string, done: string) => `En el sitio en ${title} desde las ${at}, termina como a las ${done}.`,
    already: (title: string, at: string) => `${title} ya se empezó a las ${at}.`,
    thenNext: (line: string) => ` Sigue: ${line}.`,
    thenLast: " Es la última parada de hoy.",
    stillOpen: (titles: string) => ` ${titles} todavía no está marcada como hecha.`,
    delay: (minutes: number, title: string) => `Anotado: ${minutes} min tarde en ${title}.`,
    cleared: (title: string) => `Quité el retraso en ${title}.`,
    shift: (title: string, at: string, minutes: number) => `${title} como a las ${at} (${minutes} min tarde)`,
    shifts: (list: string) => ` Ahora: ${list}.`,
    holds: " El resto del día se mantiene.",
    back: (at: string) => ` De vuelta a la base como a las ${at}.`,
    atRisk: (end: string) => ` Eso pasa del fin del día a las ${end}, así que el día sale en riesgo en la agenda.`,
  },
} satisfies Record<Language, unknown>;

/** A stop as one line: "10:30 AM 7 Pine Ave (Maria Alvarez), about 10:50 AM, 20 min late". */
export function stopLine(stop: PlanStop, customerName: string | null, replanned: boolean, timeZone: string, language: Language): string {
  const w = WORDS[language];
  const at = (d: Date) => timeText(d, timeZone, language);
  const address = stop.address && stop.address !== stop.title ? `, ${stop.address}` : "";
  const customer = customerName ? ` (${customerName})` : "";
  const late = replanned && stop.lateMinutes > 0 ? `, ${w.late(at(stop.plannedArriveAt), stop.lateMinutes)}` : "";
  return `${at(stop.startAt)} ${stop.title}${address}${customer}${late}`;
}

export type NextStop = {
  timeZone: string;
  plan: DayPlan | null;
  stop: PlanStop | null;
  visit: VisitView | null;
  mapsUrl: string | null;
  siteNotes: string[];
  checklist: string | null;
  /** How many stops are left after this one. */
  remaining: number;
  /** Ready to send. */
  text: string;
};

/**
 * The member's next stop today: its line, the drive from where they are (the stop before or the yard), a map
 * link, the visit's and the site's notes, and its checklist. Crew get their own; owners and admins anyone's
 * (`memberId`, else their own).
 */
export async function nextStop(viewer: Viewer & { language: Language }, input: { memberId?: string }, deps?: Deps): Promise<NextStop> {
  const now = deps?.now ?? new Date();
  const memberId = (isPrivileged(viewer.role) ? input.memberId : undefined) ?? viewer.memberId;
  const empty = { stop: null, visit: null, mapsUrl: null, siteNotes: [], checklist: null, remaining: 0 };
  const w = WORDS[viewer.language];
  if (!memberId) return { timeZone: "UTC", plan: null, ...empty, text: w.last(null) };
  const { plan, timeZone } = await todayPlan(viewer, memberId, now);
  const at = (d: Date) => timeText(d, timeZone, viewer.language);
  const index = plan ? nextStopIndex(plan) : -1;
  if (!plan || index < 0) {
    return { timeZone, plan, ...empty, text: w.last(plan?.backAtYardAt ? at(plan.backAtYardAt) : null) };
  }
  const stop = plan.stops[index];
  const visit = await getVisit(viewer, stop.visitId);
  const [notes, checklist] = visit
    ? await Promise.all([siteNotes(viewer, visit), checklistLines(viewer.orgId, visit.jobId, viewer.language)])
    : [[], null];
  const link = stop.address ? mapsUrl(stop.address) : null;
  const lines = [`${w.next}: ${stopLine(stop, visit?.customerName ?? null, plan.replan !== null, timeZone, viewer.language)}.`];
  if (stop.legIn && stop.legIn.minutes > 0) lines[0] += ` ${w.drive(stop.legIn.minutes, stop.legIn.yard ? w.yard : stop.legIn.label)}`;
  if (link) lines.push(link);
  if (visit?.notes) lines.push(`${w.notes}: ${visit.notes}`);
  if (notes.length) lines.push(`${w.siteNotes}: ${notes.join("; ")}`);
  const text = checklist ? `${lines.join("\n")}\n\n${checklist}` : lines.join("\n");
  return {
    timeZone,
    plan,
    stop,
    visit,
    mapsUrl: link,
    siteNotes: notes,
    checklist,
    remaining: plan.stops.slice(index + 1).filter((s) => !s.startedAt && !isDone(s)).length,
    text,
  };
}

/** The next stop as one line for a reply ("10:30 AM 7 Pine Ave"), or null when none is left. */
function nextLine(plan: DayPlan, timeZone: string, language: Language): string | null {
  const index = nextStopIndex(plan);
  return index < 0 ? null : stopLine(plan.stops[index], null, plan.replan !== null, timeZone, language);
}

export type StartedStop = {
  visit: VisitView;
  alreadyStarted: boolean;
  plan: DayPlan | null;
  timeZone: string;
  /** About when it'll be done, re-planned. */
  doneAbout: Date | null;
  next: string | null;
  /** Stops before this one they were on and haven't marked done. */
  stillOpen: string[];
  text: string;
};

/**
 * The crew are on site: starts `visitId`, or with none the member's next stop today, and replies with when it'll
 * be done and what's next. Throws `NO_STOP_TODAY` when they have none left.
 */
export async function startStop(actor: Actor, input: { visitId?: string }, deps?: Deps): Promise<StartedStop> {
  const now = deps?.now ?? new Date();
  let visitId = input.visitId;
  if (!visitId) {
    const { plan } = await todayPlan(actor, actor.memberId, now);
    const index = plan ? nextStopIndex(plan) : -1;
    if (!plan || index < 0) throw new Error("NO_STOP_TODAY");
    visitId = plan.stops[index].visitId;
  }
  const started = await startVisit(actor, { visitId }, { now });
  const { plan, timeZone } = await todayPlan(actor, dayOwner(actor, started.visit), now);
  const w = WORDS[actor.language];
  const at = (d: Date) => timeText(d, timeZone, actor.language);
  const index = plan ? plan.stops.findIndex((s) => s.visitId === visitId) : -1;
  const stop = index >= 0 && plan ? plan.stops[index] : null;
  const stillOpen = plan && index > 0 ? plan.stops.slice(0, index).filter((s) => s.startedAt && !isDone(s)).map((s) => s.title) : [];
  const next = plan ? nextLine(plan, timeZone, actor.language) : null;
  const startedAt = started.visit.startedAt ?? now;
  let text = started.alreadyStarted ? w.already(started.visit.title, at(startedAt)) : w.started(started.visit.title, at(startedAt), at(stop?.plannedLeaveAt ?? started.visit.endAt));
  text += next ? w.thenNext(next) : w.thenLast;
  if (stillOpen.length) text += w.stillOpen(stillOpen.join(", "));
  return { visit: started.visit, alreadyStarted: started.alreadyStarted, plan, timeZone, doneAbout: stop?.plannedLeaveAt ?? null, next, stillOpen, text };
}

export type DeclaredDelay = {
  visit: VisitView;
  plan: DayPlan | null;
  timeZone: string;
  /** The stops still ahead they'd reach late, re-planned. */
  shifts: Array<{ visitId: string; title: string; arriveAbout: Date; lateMinutes: number }>;
  backAbout: Date | null;
  atRisk: boolean;
  text: string;
};

/**
 * The crew are running late: sets `minutes` on `visitId`, or with none on the stop they're on (else their next),
 * re-plans the day, and replies with what shifts and whether the day is now at risk. 0 clears it. Throws
 * `NO_STOP_TODAY` when they have none left.
 */
export async function declareDelay(actor: Actor, input: { minutes: number; visitId?: string }, deps?: Deps): Promise<DeclaredDelay> {
  const now = deps?.now ?? new Date();
  let visitId = input.visitId;
  if (!visitId) {
    const { plan } = await todayPlan(actor, actor.memberId, now);
    const index = plan ? currentStopIndex(plan) : -1;
    if (!plan || index < 0) throw new Error("NO_STOP_TODAY");
    visitId = plan.stops[index].visitId;
  }
  const visit = await setVisitDelay(actor, { visitId, minutes: input.minutes }, { now });
  const { plan, timeZone } = await todayPlan(actor, dayOwner(actor, visit), now);
  const w = WORDS[actor.language];
  const at = (d: Date) => timeText(d, timeZone, actor.language);
  const index = plan ? plan.stops.findIndex((s) => s.visitId === visitId) : -1;
  const shifts =
    plan && index >= 0
      ? plan.stops
          .slice(index)
          .filter((s) => !s.startedAt && !isDone(s) && s.lateMinutes > 0)
          .map((s) => ({ visitId: s.visitId, title: s.title, arriveAbout: s.plannedArriveAt, lateMinutes: s.lateMinutes }))
      : [];
  const backAbout = plan?.backAtYardAt ?? null;
  const atRisk = plan?.atRisk ?? false;
  let text = visit.delayMinutes === 0 ? w.cleared(visit.title) : w.delay(visit.delayMinutes, visit.title);
  text += shifts.length ? w.shifts(shifts.map((s) => w.shift(s.title, at(s.arriveAbout), s.lateMinutes)).join(", ")) : w.holds;
  if (backAbout) text += w.back(at(backAbout));
  if (atRisk && plan?.replan?.dayEndAt) text += w.atRisk(at(plan.replan.dayEndAt));
  return { visit, plan, timeZone, shifts, backAbout, atRisk, text };
}

/**
 * After someone on a stop of today's marks it done, what's next on their day, re-planned: "Next: 10:30 AM 7 Pine
 * Ave." or "No more stops today. Back at the yard about 2:30 PM." Null for anyone not on it, or another day's.
 */
export async function nextAfterDone(actor: Actor, visit: VisitView, deps?: Deps): Promise<string | null> {
  const now = deps?.now ?? new Date();
  if (!visit.crew.some((c) => c.memberId === actor.memberId)) return null;
  const { plan, timeZone } = await todayPlan(actor, actor.memberId, now);
  if (!plan || !plan.stops.some((s) => s.visitId === visit.visitId) || wallClock(visit.startAt, timeZone).date !== plan.date) return null;
  const w = WORDS[actor.language];
  const line = nextLine(plan, timeZone, actor.language);
  return line ? `${w.next}: ${line}.` : w.last(plan.backAtYardAt ? timeText(plan.backAtYardAt, timeZone, actor.language) : null);
}

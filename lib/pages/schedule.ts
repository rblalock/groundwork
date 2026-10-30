import { z } from "zod";
import { plansIn, type DayPlan, type PlanStop, type Replan } from "../../core/day-plan";
import { getProfile } from "../../core/profile";
import { proposeRouteDays, recurringJobCount } from "../../core/route-days";
import { applyProposal, dropProposal, itemLine, linesFrom, openProposals, summaryText, type Proposal } from "../../core/proposals";
import {
  addTimeOff,
  bookVisit,
  changeVisitStatus,
  closeServiceJob,
  findAvailability,
  readSchedule,
  removeTimeOff,
  rescheduleVisit,
  scheduleCrew,
  serviceJobsAbout,
  setWorkHours,
  toSchedule,
  type CrewMember,
  type ServiceJobView,
  type ToSchedule,
  type VisitView,
} from "../../core/scheduling";
import { CLOCK, isYmd, wallClock, weekStart, workHoursSchema, type WorkingInterval } from "../../core/scheduling-time";
import { addDays } from "../../core/time";
import { scheduleWeather } from "../../core/weather";
import { HttpError, memberCaller, type AppCaller } from "../guards";
import { pageCopyFor } from "../page-copy";
import { notFound, privilegedActor } from "./access";
import { jobInvoicesFor } from "./invoices";

// Who may see and do what on the Schedule page, through the same library the assistant's tools use.
// Everyone sees the whole schedule and marks visits done. Owners and admins plan it; crew add
// their own time off. A super admin's look-only view sees what an owner sees. The route view shows each
// crew member's day as a route (`core/day-plan.ts`): everyone's to owners and admins, a crew member's own,
// today's re-planned from now.

export const SCHEDULE_VIEWS = ["day", "week", "route"] as const;
export type ScheduleView = (typeof SCHEDULE_VIEWS)[number];

/** A visit as the page gets it: instants as ISO strings, so it crosses to the browser as is. */
export type VisitJson = Omit<VisitView, "startAt" | "endAt" | "startedAt" | "completedAt"> & {
  startAt: string;
  endAt: string;
  startedAt: string | null;
  completedAt: string | null;
};
export type TimeOffJson = { id: string; memberId: string | null; memberName: string | null; startAt: string; endAt: string; reason: string | null };
export type CrewJson = Pick<CrewMember, "memberId" | "name" | "role" | "hours" | "ownHours">;
export type ToScheduleJson = (ToSchedule extends infer T ? (T extends { since: Date } ? Omit<T, "since"> & { since: string } : never) : never);

export const visitJson = (v: VisitView): VisitJson => ({
  ...v,
  startAt: v.startAt.toISOString(),
  endAt: v.endAt.toISOString(),
  startedAt: v.startedAt?.toISOString() ?? null,
  completedAt: v.completedAt?.toISOString() ?? null,
});

type Instants<T, K extends keyof T> = Omit<T, K> & { [P in K]: null extends T[P] ? string | null : string };
export type PlanStopJson = Instants<PlanStop, "plannedArriveAt" | "startAt" | "endAt" | "plannedLeaveAt" | "startedAt" | "completedAt">;
export type ReplanJson = Instants<Replan, "at" | "bookedBackAtYardAt" | "dayEndAt" | "latestBackAt">;
export type DayPlanJson = Instants<Omit<DayPlan, "stops" | "replan">, "leaveYardAt" | "backAtYardAt"> & { stops: PlanStopJson[]; replan: ReplanJson | null };

const iso = (at: Date | null) => (at ? at.toISOString() : null);
export const planJson = (plan: DayPlan): DayPlanJson => ({
  ...plan,
  leaveYardAt: iso(plan.leaveYardAt),
  backAtYardAt: iso(plan.backAtYardAt),
  stops: plan.stops.map((s) => ({
    ...s,
    plannedArriveAt: s.plannedArriveAt.toISOString(),
    startAt: s.startAt.toISOString(),
    endAt: s.endAt.toISOString(),
    plannedLeaveAt: s.plannedLeaveAt.toISOString(),
    startedAt: iso(s.startedAt),
    completedAt: iso(s.completedAt),
  })),
  replan: plan.replan
    ? {
        ...plan.replan,
        at: plan.replan.at.toISOString(),
        bookedBackAtYardAt: iso(plan.replan.bookedBackAtYardAt),
        dayEndAt: iso(plan.replan.dayEndAt),
        latestBackAt: iso(plan.replan.latestBackAt),
      }
    : null,
});

export type SchedulePage = {
  view: ScheduleView;
  /** The day the view is anchored on; a week view shows that day's Monday to Sunday. */
  date: string;
  dates: string[];
  today: string;
  timeZone: string;
  /** The lanes: everyone for owners and admins, only themselves for crew. */
  crew: CrewJson[];
  visits: VisitJson[];
  timeOff: TimeOffJson[];
  /** Work waiting for a visit; owners and admins only. */
  toSchedule: ToScheduleJson[];
  /** Owners and admins acting as themselves: they book, move, and cancel. */
  canManage: boolean;
  /** The viewer's member id; null for a super admin's view, which changes nothing. */
  me: string | null;
  /** Each shown job's invoice, by job id: owners and admins only (crew get none). */
  invoices: Record<string, { invoiceId: string; label: string; status: string }>;
  /** The route view's plans for the day: each crew member's with visits for owners and admins, a crew member's own. */
  plans: DayPlanJson[];
  /** Open proposals to move stops (`core/proposals.ts`), from today on; owners and admins only. */
  proposals: ProposalJson[];
  /** The route view's day's weather in one line (`core/weather.ts`), when the forecast reaches it; else null. */
  weather: string | null;
  /** Open recurring jobs at placed addresses, for planning route days (`core/route-days.ts`); owners and admins only, else 0. */
  recurringJobs: number;
};

/** A proposal as the Schedule page's card shows it: each stop's line, and the drafts that go with it. */
export type ProposalJson = {
  proposalId: string;
  kind: Proposal["kind"];
  /** The crew member whose day it moves stops off; null for a weather or route-day one, which is the business's. */
  memberName: string | null;
  date: string;
  reason: string;
  items: Array<{ id: string; title: string; customerName: string | null; line: string; crewText: string; customerText: string }>;
};

const isView = (value: string | undefined): value is ScheduleView => SCHEDULE_VIEWS.includes(value as ScheduleView);

/**
 * The Schedule page's data for a day, a week, or a day's routes: everyone's lanes. Owners and admins start on
 * the week; crew on their route when they have visits that day, else on the day.
 */
export async function scheduleFor(caller: AppCaller, input: { view?: string; date?: string; now?: Date }): Promise<SchedulePage> {
  const profile = await getProfile(caller.orgId);
  const timeZone = profile.timeZone;
  const today = wallClock(input.now ?? new Date(), timeZone).date;
  const asked = isView(input.view) ? input.view : caller.role === "member" ? null : "week";
  const date = input.date && isYmd(input.date) ? input.date : today;
  const from = asked === "week" ? weekStart(date) : date;
  const days = asked === "week" ? 7 : 1;
  const schedule = await readSchedule(caller, { from, days }, { now: input.now });
  const plans = asked === "week" || asked === "day" ? [] : plansIn(caller, schedule, profile, input.now);
  const view: ScheduleView = asked ?? (plans.length > 0 ? "route" : "day");
  const privileged = caller.role !== "member";
  const weather = view === "route" ? await scheduleWeather(profile, { from: date, to: addDays(date, 1), today, language: caller.language, now: input.now }) : [];
  return {
    view,
    date,
    dates: Array.from({ length: days }, (_, i) => addDays(from, i)),
    today,
    timeZone,
    crew: schedule.crew.map(({ memberId, name, role, hours, ownHours }) => ({ memberId, name, role, hours, ownHours })),
    visits: schedule.visits.map(visitJson),
    timeOff: schedule.timeOff.map((b) => ({
      id: b.id,
      memberId: b.memberId,
      memberName: b.memberName,
      startAt: b.startAt.toISOString(),
      endAt: b.endAt.toISOString(),
      reason: b.reason,
    })),
    toSchedule: privileged ? (await toSchedule(caller.orgId)).map((t) => ({ ...t, since: t.since.toISOString() }) as ToScheduleJson) : [],
    canManage: privileged && caller.memberId !== null,
    me: caller.memberId,
    invoices: await jobInvoicesFor(caller, schedule.visits.map((v) => v.jobId)),
    plans: view === "route" ? plans.map(planJson) : [],
    proposals: privileged ? await proposalsFor(caller, input.now) : [],
    // The strip sits under the day's own heading, so the line's day word ("Tomorrow:") is dropped.
    weather: weather[0]?.line.replace(/^[^:]*: /, "") ?? null,
    recurringJobs: privileged ? await recurringJobCount(caller.orgId) : 0,
  };
}

async function proposalsFor(caller: AppCaller, now?: Date): Promise<ProposalJson[]> {
  const open = await openProposals(caller, { now });
  return open.proposals.map((p) => ({
    proposalId: p.id,
    kind: p.kind,
    memberName: p.memberName,
    date: p.date,
    reason: p.reason,
    items: p.items.map((item) => ({
      id: item.id,
      title: item.title,
      customerName: item.customerName,
      line: itemLine(item, linesFrom(p), open.timeZone, caller.language, p.kind),
      crewText: item.crewText,
      customerText: item.customerText,
    })),
  }));
}

/** The work and visits on a quote's or customer's page. */
export async function workOn(caller: AppCaller, about: { quoteId: string } | { customerId: string }): Promise<ServiceJobView[]> {
  return serviceJobsAbout(caller, about);
}

// ---------------------------------------------------------------------------------------------
// Changes

const clock = z.string().regex(CLOCK);
const ymd = z.string().refine(isYmd, "YYYY-MM-DD");
const id = z.string().min(1).max(100);

export const bookSchema = z
  .object({
    quoteId: id.optional(),
    jobId: id.optional(),
    title: z.string().trim().min(1).max(160).optional(),
    customerId: id.optional(),
    memberIds: z.array(id).min(1).max(6),
    date: ymd,
    time: clock,
    durationMinutes: z.number().int().min(15).max(960),
    notes: z.string().max(4000).optional(),
    tentative: z.boolean().optional(),
    allowOutsideHours: z.boolean().optional(),
    allowMissingEquipment: z.boolean().optional(),
  })
  .strict();

export const rescheduleSchema = z
  .object({
    date: ymd.optional(),
    time: clock.optional(),
    durationMinutes: z.number().int().min(15).max(960).optional(),
    memberIds: z.array(id).min(1).max(6).optional(),
    notes: z.string().max(4000).optional(),
    allowOutsideHours: z.boolean().optional(),
    allowMissingEquipment: z.boolean().optional(),
  })
  .strict();

export const statusSchema = z
  .object({ status: z.enum(["completed", "cancelled", "scheduled"]), notes: z.string().max(4000).optional() })
  .strict();

export const availabilitySchema = z
  .object({
    memberIds: z.array(id).min(1).max(6),
    date: ymd,
    days: z.number().int().min(1).max(14).default(5),
    durationMinutes: z.number().int().min(15).max(960),
    visitId: id.optional(),
    quoteId: id.optional(),
    jobId: id.optional(),
  })
  .strict();

export const timeOffSchema = z
  .object({
    memberId: id.nullable(),
    date: ymd,
    endDate: ymd.optional(),
    start: clock.optional(),
    end: clock.optional(),
    reason: z.string().trim().max(200).optional(),
  })
  .strict();

export const hoursSchema = z.object({ memberId: id.nullable(), hours: workHoursSchema.nullable() }).strict();

export const closeSchema = z.object({ status: z.enum(["completed", "cancelled"]), cancelUpcomingVisits: z.boolean().optional() }).strict();

export const proposalSchema = z
  .object({ action: z.enum(["apply", "drop"]), itemIds: z.array(z.string().min(1).max(10)).min(1).max(20).optional() })
  .strict();

/** A library refusal in the member's words. English adds the specifics (who, what time). */
function scheduleRefusal(caller: AppCaller, error: unknown): never {
  if (error instanceof HttpError) throw error;
  const message = error instanceof Error ? error.message : "";
  const [code, ...rest] = message.split(":");
  const detail = rest.join(":").trim();
  const errors = pageCopyFor(caller.language).schedule.errors as Record<string, string>;
  if (code === "NOT_PRIVILEGED") throw new HttpError(403, code, "Only the owner or an admin can do that.");
  if (["VISIT_NOT_FOUND", "SERVICE_JOB_NOT_FOUND", "TIME_OFF_NOT_FOUND", "QUOTE_NOT_FOUND", "CUSTOMER_NOT_FOUND", "MEMBER_NOT_FOUND", "PROPOSAL_NOT_FOUND"].includes(code)) {
    throw notFound();
  }
  const words = errors[code];
  if (!words) throw error;
  throw new HttpError(code.startsWith("INVALID") ? 400 : 409, code, detail && caller.language === "en" ? `${words} ${detail}.` : words);
}

export async function bookFromApp(caller: AppCaller, input: z.infer<typeof bookSchema>): Promise<VisitJson> {
  const actor = privilegedActor(caller);
  try {
    const { date, notes, ...rest } = input;
    const booked = await bookVisit(actor, { ...rest, day: date, visitNotes: notes });
    return visitJson(booked.visit);
  } catch (error) {
    scheduleRefusal(caller, error);
  }
}

export async function rescheduleFromApp(caller: AppCaller, visitId: string, input: z.infer<typeof rescheduleSchema>): Promise<VisitJson> {
  const actor = privilegedActor(caller);
  try {
    const { date, notes, ...rest } = input;
    const moved = await rescheduleVisit(actor, { ...rest, visitId, day: date, visitNotes: notes });
    return visitJson(moved.visit);
  } catch (error) {
    scheduleRefusal(caller, error);
  }
}

/** Anyone on the team marks a visit done; cancelling and confirming are for owners and admins. */
export async function visitStatusFromApp(caller: AppCaller, visitId: string, input: z.infer<typeof statusSchema>): Promise<VisitJson> {
  const actor = memberCaller(caller);
  try {
    const changed = await changeVisitStatus(actor, { visitId, status: input.status, visitNotes: input.notes });
    return visitJson(changed.visit);
  } catch (error) {
    scheduleRefusal(caller, error);
  }
}

export async function closeJobFromApp(caller: AppCaller, jobId: string, input: z.infer<typeof closeSchema>): Promise<{ status: string }> {
  const actor = privilegedActor(caller);
  try {
    const closed = await closeServiceJob(actor, { jobId, ...input });
    return { status: closed.job.status };
  } catch (error) {
    scheduleRefusal(caller, error);
  }
}

export type ProposalOutcomeJson = {
  /** What moved and what didn't; the customer drafts are in `customerTexts`. */
  summaryText: string;
  moved: Array<{ itemId: string; line: string }>;
  skipped: Array<{ itemId: string; title: string; reason: string }>;
  customerTexts: Array<{ itemId: string; customerName: string | null; text: string }>;
};

/**
 * An owner or admin applies a proposal (all its stops, or those kept) or drops it, as `apply_proposal` and
 * `drop_proposal` do: the same re-checks, the same crew texts, and the customer drafts back to forward.
 */
export async function proposalFromApp(caller: AppCaller, proposalId: string, input: z.infer<typeof proposalSchema>): Promise<ProposalOutcomeJson> {
  const actor = privilegedActor(caller);
  try {
    if (input.action === "drop") {
      const dropped = await dropProposal(actor, { proposalId });
      return { summaryText: dropped.summaryText, moved: [], skipped: [], customerTexts: [] };
    }
    const applied = await applyProposal(actor, { proposalId, itemIds: input.itemIds });
    return {
      summaryText: summaryText({ moved: applied.moved, skipped: applied.skipped, customerTexts: [] }, caller.language),
      moved: applied.moved.map(({ itemId, line }) => ({ itemId, line })),
      skipped: applied.skipped,
      customerTexts: applied.customerTexts,
    };
  } catch (error) {
    scheduleRefusal(caller, error);
  }
}

/**
 * An owner or admin asks for route days, as `plan_route_days` does: a proposal on the card once there's one, and
 * the code's line either way (why there's none, when there isn't).
 */
export async function routeDaysFromApp(caller: AppCaller): Promise<{ proposed: boolean; text: string }> {
  const actor = privilegedActor(caller);
  try {
    const { proposal, text } = await proposeRouteDays(actor);
    return { proposed: proposal !== null, text };
  } catch (error) {
    scheduleRefusal(caller, error);
  }
}

export type SlotJson = { date: string; start: string; end: string };

/** Open times for the crew picked; crew may only look up themselves. */
export async function availabilityFromApp(caller: AppCaller, input: z.infer<typeof availabilitySchema>): Promise<SlotJson[]> {
  try {
    const found = await findAvailability(caller, {
      memberIds: input.memberIds,
      from: input.date,
      days: input.days,
      durationMinutes: input.durationMinutes,
      reschedulingVisitId: input.visitId,
      quoteId: input.quoteId,
      jobId: input.jobId,
      limit: 60,
      order: "time",
    });
    return found.slots.map(({ date, start, end }) => ({ date, start, end }));
  } catch (error) {
    scheduleRefusal(caller, error);
  }
}

export async function addTimeOffFromApp(caller: AppCaller, input: z.infer<typeof timeOffSchema>): Promise<{ id: string }> {
  const actor = memberCaller(caller);
  try {
    const block = await addTimeOff(actor, { memberId: input.memberId, day: input.date, endDay: input.endDate, start: input.start, end: input.end, reason: input.reason });
    return { id: block.id };
  } catch (error) {
    scheduleRefusal(caller, error);
  }
}

export async function removeTimeOffFromApp(caller: AppCaller, blockId: string): Promise<void> {
  const actor = memberCaller(caller);
  try {
    await removeTimeOff(actor, blockId);
  } catch (error) {
    scheduleRefusal(caller, error);
  }
}

export async function setHoursFromApp(caller: AppCaller, input: z.infer<typeof hoursSchema>): Promise<{ hours: WorkingInterval[]; outsideHours: number }> {
  const actor = privilegedActor(caller);
  try {
    const saved = await setWorkHours(actor, { memberId: input.memberId, hours: input.hours });
    return { hours: saved.hours, outsideHours: saved.outsideHours.length };
  } catch (error) {
    scheduleRefusal(caller, error);
  }
}

/** The business's hours and each member's, for the hours editor. Owners and admins. */
export async function hoursFor(caller: AppCaller): Promise<{ business: WorkingInterval[]; crew: CrewJson[] }> {
  if (caller.role === "member") throw new HttpError(403, "NOT_PRIVILEGED", "Only the owner or an admin can do that.");
  const [profile, crew] = await Promise.all([getProfile(caller.orgId), scheduleCrew(caller.orgId)]);
  return { business: profile.workHours, crew: crew.map(({ memberId, name, role, hours, ownHours }) => ({ memberId, name, role, hours, ownHours })) };
}

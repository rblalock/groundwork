// The schedule: service jobs (the work a won quote becomes, or work on its own), their visits, who goes,
// working hours, and time off. The
// people booked are our members, the business's time zone is its profile's, and every query is scoped
// by the caller's org. The tools and the web pages both call these.
//
// Who may do what: owners and admins book, move, and cancel visits, open and close jobs, set hours, and
// add anyone's time off. Everyone reads the whole schedule and marks visits done; crew add or remove
// their own time off. Booking someone sends them a heads-up text (never a customer: they don't text us).
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, notExists, or, sql, type SQL } from "drizzle-orm";
import {
  busyBlocks,
  businessProfile,
  checklistItems,
  customers,
  members,
  pricebookItems,
  properties,
  quoteRevisions,
  quotes,
  serviceJobs,
  visitCrew,
  visitRevisions,
  visits,
} from "../schema/schema";
import { db, newId, type Db, type Tx } from "./db";
import { carriesAll, equipmentUnion, missingEquipment } from "./equipment";
import { recordEvent } from "./events";
import { isLanguage, type Language } from "./language";
import { isPrivileged, privilegedMembers, type Caller, type Member } from "./members";
import { planDay, type DayPlan } from "./day-plan";
import { crewAddedDrive, crewDrives, driveSettingsOf, legsAround, placeOf, yardOf, type Leg, type Place, type Stop } from "./places";
import { getProfileWith, type Profile } from "./profile";
import { crewChecklist, type CrewChecklist } from "./checklist";
import type { Poster } from "./quotes";
import { everyOf, nextOccurrenceFrom, recurrenceText, type Recurrence, type Recurring } from "./recurrence";
import {
  clockMinutes,
  dayText,
  intervalsOverlap,
  localTimeInstants,
  minutesClock,
  occupiedInterval,
  offsetMinutesAt,
  resolveDay,
  resolveLocalTime,
  timeText,
  wallClock,
  weekdayOf,
  whenText,
  withinWorkingHours,
  workHoursSchema,
  workingSegments,
  type Interval,
  type WorkingInterval,
} from "./scheduling-time";
import { addDays } from "./time";

export type ServiceJob = typeof serviceJobs.$inferSelect;
export type Visit = typeof visits.$inferSelect;
export type VisitStatus = Visit["status"];
export type BusyBlock = typeof busyBlocks.$inferSelect;
/** Who is acting: a member of the business, as the tools and the web pages pass it. */
export type Actor = Pick<Caller, "orgId" | "memberId" | "role" | "name" | "language">;
/** Who is looking: a super admin's look-only view has no member and sees what an owner sees. */
export type Viewer = { orgId: string; memberId: string | null; role: Caller["role"] };

export type CrewRef = { memberId: string; name: string };

export type VisitView = {
  visitId: string;
  jobId: string;
  title: string;
  jobStatus: ServiceJob["status"];
  customerId: string | null;
  customerName: string | null;
  address: string | null;
  propertyId: string | null;
  /** Where the address is; null when it couldn't be placed (`core/places.ts`). */
  place: Place | null;
  quoteId: string | null;
  crew: CrewRef[];
  startAt: Date;
  endAt: Date;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  status: VisitStatus;
  /** When the crew said they're on site; null until then. */
  startedAt: Date | null;
  completedAt: Date | null;
  /** A delay the crew declared on it, in minutes; 0 for none. */
  delayMinutes: number;
  notes: string | null;
  revision: number;
  /** How much of the work's checklist is ticked; null when it has none. */
  checklist: { done: number; total: number } | null;
  /** How the work repeats (`core/recurrence.ts`); null for one-off work. */
  recurrence: Recurrence | null;
  /**
   * The drives around it on its first crew member's day (`withDrives`): from the stop before or the yard, and to
   * the stop after or back to the yard. A side is null when either end is unplaced. Absent when not worked out.
   */
  drive?: { fromPrevious: Leg | null; toNext: Leg | null };
};

type Deps = { now?: Date; post?: Poster };

export const DEFAULT_VISIT_MINUTES = 60;
const MINUTE = 60_000;
const HOLDS_TIME: VisitStatus[] = ["proposed", "scheduled", "completed"];
const OPEN_VISIT: VisitStatus[] = ["proposed", "scheduled"];
/** A quote the owner has agreed the money on: what can become scheduled work. */
const AGREED_QUOTE = ["approved", "sent", "won"] as const;

function requirePrivileged(actor: Pick<Actor, "role">): void {
  if (!isPrivileged(actor.role)) throw new Error("NOT_PRIVILEGED");
}

/** One booking at a time per business, so two can't both take the same crew's hour. */
export async function lockSchedule(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`schedule:${orgId}`}))`);
}

const languageOf = (member: Pick<Member, "language">): Language => (isLanguage(member.language) ? member.language : "en");

// ---------------------------------------------------------------------------------------------
// Crew and hours

export type CrewMember = {
  memberId: string;
  name: string;
  role: Member["role"];
  hours: WorkingInterval[];
  ownHours: boolean;
  /** What their truck carries. */
  equipment: string[];
};

/** The business's active members with the hours each works: their own, or the business's. */
export async function scheduleCrew(orgId: string, executor: Db | Tx = db()): Promise<CrewMember[]> {
  const profile = await getProfileWith(orgId, executor);
  const rows = await executor
    .select()
    .from(members)
    .where(and(eq(members.orgId, orgId), eq(members.status, "active")))
    .orderBy(asc(members.createdAt), asc(members.id));
  return rows.map((m) => ({
    memberId: m.id,
    name: m.name,
    role: m.role,
    hours: m.workHours ?? profile.workHours,
    ownHours: m.workHours !== null,
    equipment: m.equipment,
  }));
}

/** The named members, active in this business, in the order given, without repeats. Throws `MEMBER_NOT_FOUND`. */
async function crewFor(orgId: string, memberIds: string[], executor: Db | Tx): Promise<CrewMember[]> {
  const ids = [...new Set(memberIds)];
  if (ids.length === 0) throw new Error("CREW_REQUIRED");
  const crew = await scheduleCrew(orgId, executor);
  return ids.map((id) => {
    const found = crew.find((c) => c.memberId === id);
    if (!found) throw new Error(`MEMBER_NOT_FOUND: ${id}`);
    return found;
  });
}

/**
 * Sets working hours: the business's (no `memberId`), or one member's own (`hours: null` puts them
 * back on the business's). Owners and admins only. Returns the open visits now outside those hours,
 * which stay booked, so the member can be told.
 */
export async function setWorkHours(
  actor: Actor,
  input: { memberId?: string | null; hours: WorkingInterval[] | null },
  deps?: Deps,
): Promise<{ hours: WorkingInterval[]; outsideHours: VisitView[] }> {
  requirePrivileged(actor);
  const { orgId } = actor;
  if (input.hours === null && !input.memberId) throw new Error("INVALID_HOURS: the business needs hours");
  const parsed = input.hours === null ? null : workHoursSchema.safeParse(input.hours);
  if (parsed && !parsed.success) throw new Error(`INVALID_HOURS: ${parsed.error.issues[0]?.message ?? "check the hours"}`);
  const hours = parsed?.data ?? null;
  await db().transaction(async (tx) => {
    if (input.memberId) {
      const updated = await tx
        .update(members)
        .set({ workHours: hours })
        .where(and(eq(members.orgId, orgId), eq(members.id, input.memberId), eq(members.status, "active")))
        .returning({ id: members.id });
      if (updated.length === 0) throw new Error("MEMBER_NOT_FOUND");
    } else {
      await getProfileWith(orgId, tx);
      await tx.update(businessProfile).set({ workHours: hours ?? [], updatedAt: new Date() }).where(eq(businessProfile.orgId, orgId));
    }
    await recordEvent({ orgId, kind: "schedule.hours", refId: input.memberId ?? undefined, memberId: actor.memberId, data: { hours } }, tx);
  });
  const crew = await scheduleCrew(orgId);
  const affected = input.memberId ? crew.filter((c) => c.memberId === input.memberId) : crew.filter((c) => !c.ownHours);
  const now = deps?.now ?? new Date();
  const profile = await getProfileWith(orgId, db());
  const upcoming = await loadVisitViews(orgId, [inArray(visits.status, OPEN_VISIT), gt(visits.endAt, now)]);
  const outsideHours = upcoming.filter((v) =>
    v.crew.some((c) => {
      const member = affected.find((a) => a.memberId === c.memberId);
      return member && !withinWorkingHours(occupiedInterval(v).startAt, occupiedInterval(v).endAt, profile.timeZone, member.hours);
    }),
  );
  const resolved = input.memberId ? (affected[0]?.hours ?? []) : (hours ?? []);
  return { hours: resolved, outsideHours };
}

// ---------------------------------------------------------------------------------------------
// Reading visits

function visitQuery(executor: Db | Tx, orgId: string) {
  return executor
    .select({ visit: visits, job: serviceJobs, customerName: customers.name, address: properties.address, lat: properties.lat, lng: properties.lng })
    .from(visits)
    .innerJoin(serviceJobs, and(eq(serviceJobs.orgId, orgId), eq(serviceJobs.id, visits.jobId)))
    .leftJoin(customers, and(eq(customers.orgId, orgId), eq(customers.id, serviceJobs.customerId)))
    .leftJoin(properties, and(eq(properties.orgId, orgId), eq(properties.id, serviceJobs.propertyId)));
}

async function crewOf(orgId: string, visitIds: string[], executor: Db | Tx): Promise<Map<string, CrewRef[]>> {
  const out = new Map<string, CrewRef[]>();
  if (visitIds.length === 0) return out;
  const rows = await executor
    .select({ visitId: visitCrew.visitId, memberId: members.id, name: members.name })
    .from(visitCrew)
    .innerJoin(members, and(eq(members.orgId, orgId), eq(members.id, visitCrew.memberId)))
    .where(and(eq(visitCrew.orgId, orgId), inArray(visitCrew.visitId, visitIds)))
    .orderBy(asc(members.createdAt), asc(members.id));
  for (const row of rows) out.set(row.visitId, [...(out.get(row.visitId) ?? []), { memberId: row.memberId, name: row.name }]);
  return out;
}

/** Each job's checklist, as how many items are ticked of how many; jobs with none are left out. */
async function checklistCounts(orgId: string, jobIds: string[], executor: Db | Tx): Promise<Map<string, { done: number; total: number }>> {
  if (jobIds.length === 0) return new Map();
  const rows = await executor
    .select({ jobId: checklistItems.jobId, done: sql<number>`count(${checklistItems.doneAt})::int`, total: sql<number>`count(*)::int` })
    .from(checklistItems)
    .where(and(eq(checklistItems.orgId, orgId), inArray(checklistItems.jobId, [...new Set(jobIds)])))
    .groupBy(checklistItems.jobId);
  return new Map(rows.map((row) => [row.jobId, { done: row.done, total: row.total }]));
}

/** Visits matching `where`, earliest first, with their job, customer, address, and crew. */
async function loadVisitViews(orgId: string, where: SQL[], executor: Db | Tx = db(), limit = 500): Promise<VisitView[]> {
  const rows = await visitQuery(executor, orgId)
    .where(and(eq(visits.orgId, orgId), ...where))
    .orderBy(asc(visits.startAt), asc(visits.id))
    .limit(limit);
  const crew = await crewOf(orgId, rows.map((r) => r.visit.id), executor);
  const checklists = await checklistCounts(orgId, rows.map((r) => r.job.id), executor);
  return rows.map(({ visit, job, customerName, address, lat, lng }) => ({
    visitId: visit.id,
    jobId: job.id,
    title: job.title,
    jobStatus: job.status,
    customerId: job.customerId,
    customerName,
    address,
    propertyId: job.propertyId,
    place: address ? placeOf({ lat, lng }, address) : null,
    quoteId: job.quoteId,
    crew: crew.get(visit.id) ?? [],
    startAt: visit.startAt,
    endAt: visit.endAt,
    bufferBeforeMinutes: visit.bufferBeforeMinutes,
    bufferAfterMinutes: visit.bufferAfterMinutes,
    status: visit.status,
    startedAt: visit.startedAt,
    completedAt: visit.completedAt,
    delayMinutes: visit.delayMinutes,
    notes: visit.notes,
    revision: visit.revision,
    checklist: checklists.get(job.id) ?? null,
    recurrence: job.recurrence ?? null,
  }));
}

/** Only visits this member is on. */
const onVisit = (orgId: string, memberId: string) =>
  inArray(
    visits.id,
    db()
      .select({ id: visitCrew.visitId })
      .from(visitCrew)
      .where(and(eq(visitCrew.orgId, orgId), eq(visitCrew.memberId, memberId))),
  );

/** One visit of the viewer's business. Everyone on the team sees the whole schedule. */
export async function getVisit(viewer: Viewer, visitId: string, executor: Db | Tx = db()): Promise<VisitView | null> {
  const [view] = await loadVisitViews(viewer.orgId, [eq(visits.id, visitId)], executor, 1);
  return view ?? null;
}

/** The first instant of a local day (midnight, or the first minute after a gap at midnight). */
function dayStart(ymd: string, timeZone: string): Date {
  for (const clock of ["00:00", "00:30", "01:00", "02:00"]) {
    const [first] = localTimeInstants(ymd, clock, timeZone);
    if (first) return first;
  }
  return resolveLocalTime(ymd, "12:00", timeZone);
}

export type ScheduleWindow = {
  timeZone: string;
  today: string;
  from: string;
  /** The day after the last one shown. */
  to: string;
  crew: CrewMember[];
  visits: VisitView[];
  timeOff: Array<BusyBlock & { memberName: string | null }>;
};

/**
 * The schedule from `from` for `days` days, in the business's time zone. Owners and admins see everyone
 * (or one member with `memberId`). Cancelled visits only with `includeCancelled`.
 */
export async function readSchedule(
  viewer: Viewer,
  input: { from: string; days: number; memberId?: string; includeCancelled?: boolean },
  deps?: { now?: Date },
): Promise<ScheduleWindow> {
  const { orgId } = viewer;
  const profile = await getProfileWith(orgId, db());
  const timeZone = profile.timeZone;
  const days = Math.min(Math.max(Math.trunc(input.days), 1), 42);
  const from = resolveDay(input.from, timeZone, deps?.now);
  const to = addDays(from, days);
  const memberId = input.memberId;
  const start = dayStart(from, timeZone);
  const end = dayStart(to, timeZone);
  const where: SQL[] = [lt(visits.startAt, end), gt(visits.endAt, start)];
  if (!input.includeCancelled) where.push(ne(visits.status, "cancelled"));
  if (memberId) where.push(onVisit(orgId, memberId));
  const allCrew = await scheduleCrew(orgId);
  const blocks = await db()
    .select({ block: busyBlocks, memberName: members.name })
    .from(busyBlocks)
    .leftJoin(members, and(eq(members.orgId, orgId), eq(members.id, busyBlocks.memberId)))
    .where(
      and(
        eq(busyBlocks.orgId, orgId),
        isNull(busyBlocks.cancelledAt),
        lt(busyBlocks.startAt, end),
        gt(busyBlocks.endAt, start),
        ...(memberId ? [or(isNull(busyBlocks.memberId), eq(busyBlocks.memberId, memberId)) as SQL] : []),
      ),
    )
    .orderBy(asc(busyBlocks.startAt), asc(busyBlocks.id));
  return {
    timeZone,
    today: wallClock(deps?.now ?? new Date(), timeZone).date,
    from,
    to,
    crew: memberId ? allCrew.filter((c) => c.memberId === memberId) : allCrew,
    visits: await withDrives(orgId, await loadVisitViews(orgId, where), profile),
    timeOff: blocks.map(({ block, memberName }) => ({ ...block, memberName })),
  };
}

/** Open visits (proposed or scheduled) that start on the local day `ymd`, for everyone or one member. */
export async function visitsOnDay(orgId: string, ymd: string, timeZone: string, memberId?: string): Promise<VisitView[]> {
  const where: SQL[] = [
    inArray(visits.status, OPEN_VISIT),
    sql`${visits.startAt} >= ${dayStart(ymd, timeZone).toISOString()}`,
    lt(visits.startAt, dayStart(addDays(ymd, 1), timeZone)),
  ];
  if (memberId) where.push(onVisit(orgId, memberId));
  return loadVisitViews(orgId, where);
}

// ---------------------------------------------------------------------------------------------
// Drives

const stopOf = (v: Pick<VisitView, "startAt" | "place">): Stop => ({ startAt: v.startAt, place: v.place });

/**
 * Adds each visit's drives (`VisitView.drive`), from its first crew member's other visits that day and the
 * yard. Cancelled visits and visits with no crew get none.
 */
async function withDrives(orgId: string, views: VisitView[], profile: Profile, executor: Db | Tx = db()): Promise<VisitView[]> {
  const routed = new Set(views.filter((v) => v.status !== "cancelled" && v.crew.length > 0));
  if (routed.size === 0) return views;
  const timeZone = profile.timeZone;
  const dates = new Map<string, string>();
  const dateOf = (v: VisitView) => {
    const known = dates.get(v.visitId);
    if (known) return known;
    const date = wallClock(v.startAt, timeZone).date;
    dates.set(v.visitId, date);
    return date;
  };
  const days = [...routed].map(dateOf).sort();
  const sameDays = await loadVisitViews(
    orgId,
    [inArray(visits.status, HOLDS_TIME), gte(visits.startAt, dayStart(days[0], timeZone)), lt(visits.startAt, dayStart(addDays(days[days.length - 1], 1), timeZone))],
    executor,
    2000,
  );
  const yard = yardOf(profile);
  const settings = driveSettingsOf(profile);
  return views.map((v) => {
    if (!routed.has(v)) return v;
    const lead = v.crew[0].memberId;
    const stops = sameDays.filter((o) => o.visitId !== v.visitId && dateOf(o) === dateOf(v) && o.crew.some((c) => c.memberId === lead)).map(stopOf);
    const legs = legsAround(stopOf(v), stops, yard, settings);
    return { ...v, drive: { fromPrevious: legs.before, toNext: legs.after } };
  });
}

/** One of the business's properties, placed or not. Throws `PROPERTY_NOT_FOUND`. */
async function propertyPlace(orgId: string, propertyId: string, executor: Db | Tx): Promise<{ propertyId: string; place: Place | null }> {
  const [row] = await executor
    .select({ address: properties.address, lat: properties.lat, lng: properties.lng })
    .from(properties)
    .where(and(eq(properties.orgId, orgId), eq(properties.id, propertyId)));
  if (!row) throw new Error("PROPERTY_NOT_FOUND");
  return { propertyId, place: placeOf(row, row.address) };
}

/** Where the work is: the property given, else its job's, else its quote's. Null when none is known. */
async function workPlace(
  orgId: string,
  input: { propertyId?: string; jobId?: string; quoteId?: string },
  executor: Db | Tx,
): Promise<{ propertyId: string; place: Place | null } | null> {
  if (input.propertyId) return propertyPlace(orgId, input.propertyId, executor);
  if (input.jobId) {
    const job = await jobRow(orgId, input.jobId, executor);
    if (!job) throw new Error("SERVICE_JOB_NOT_FOUND");
    if (job.propertyId) return propertyPlace(orgId, job.propertyId, executor);
  }
  if (input.quoteId) {
    const [quote] = await executor.select({ propertyId: quotes.propertyId }).from(quotes).where(and(eq(quotes.orgId, orgId), eq(quotes.id, input.quoteId)));
    if (!quote) throw new Error("QUOTE_NOT_FOUND");
    if (quote.propertyId) return propertyPlace(orgId, quote.propertyId, executor);
  }
  return null;
}

/**
 * What the work needs: everything its quote's items need (`core/equipment.ts`), from the quote's current lines
 * as its checklist is. Work without a quote, and lines without an item, need nothing.
 */
async function equipmentNeeded(orgId: string, quoteId: string | null | undefined, executor: Db | Tx): Promise<string[]> {
  if (!quoteId) return [];
  const [revision] = await executor
    .select({ lines: quoteRevisions.lines })
    .from(quotes)
    .innerJoin(quoteRevisions, and(eq(quoteRevisions.orgId, quotes.orgId), eq(quoteRevisions.id, quotes.currentRevisionId)))
    .where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId)));
  const itemIds = [...new Set((revision?.lines ?? []).flatMap((line) => (line.itemId ? [line.itemId] : [])))];
  if (!itemIds.length) return [];
  const items = await executor
    .select({ id: pricebookItems.id, equipment: pricebookItems.equipment })
    .from(pricebookItems)
    .where(and(eq(pricebookItems.orgId, orgId), inArray(pricebookItems.id, itemIds)));
  return equipmentUnion(itemIds.map((id) => items.find((item) => item.id === id)?.equipment ?? []));
}

type Buffers = { bufferBeforeMinutes: number; bufferAfterMinutes: number; driveEstimated: boolean };

/**
 * A visit's buffers: each the member gave, else the drive (`crewDrives`), else today's default when the drive
 * can't be estimated (an unplaced end). `driveEstimated` is false when one fell back to the default.
 */
function visitBuffers(given: { before?: number; after?: number }, drives: { before: number | null; after: number | null }): Buffers {
  const side = (minutes: number | undefined, drive: number | null) =>
    minutes !== undefined ? { minutes: clampBuffer(minutes), fell: false } : drive !== null ? { minutes: drive, fell: false } : { minutes: clampBuffer(undefined), fell: true };
  const before = side(given.before, drives.before);
  const after = side(given.after, drives.after);
  return { bufferBeforeMinutes: before.minutes, bufferAfterMinutes: after.minutes, driveEstimated: !before.fell && !after.fell };
}

/** Each crew member's visits holding time on the local day `date`, other than `excludeVisitId`, as stops. */
async function crewStopsOn(orgId: string, crew: CrewMember[], date: string, timeZone: string, executor: Db | Tx, excludeVisitId?: string): Promise<Stop[][]> {
  const window = { startAt: dayStart(date, timeZone), endAt: dayStart(addDays(date, 1), timeZone) };
  const out: Stop[][] = [];
  for (const member of crew) {
    const taken = await occupancy(orgId, member.memberId, window, executor, excludeVisitId);
    out.push(taken.visits.filter((v) => wallClock(v.startAt, timeZone).date === date).map(stopOf));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Availability

export type Slot = {
  date: string;
  start: string;
  end: string;
  startAt: Date;
  endAt: Date;
  offsetMinutes: number;
  /** Who it's for: the crew asked for, or one member when nobody was named. */
  crew: CrewRef[];
  /** The crew's drive in from the stop before (or the yard), and out to the next (or back); null when unplaced. */
  driveFromPreviousMinutes: number | null;
  driveToNextMinutes: number | null;
  driveEstimated: boolean;
  /** The driving it adds to the crew's day (the most it adds to anyone's on it); null when a place is unplaced. */
  addedDriveMinutes: number | null;
  /** Everyone's day stays within the business's capacity with it in. */
  fits: boolean;
};

async function occupancy(
  orgId: string,
  memberId: string,
  window: Interval,
  executor: Db | Tx,
  excludeVisitId?: string,
): Promise<{ visits: VisitView[]; blocks: BusyBlock[] }> {
  const busyVisits = await loadVisitViews(
    orgId,
    [
      inArray(visits.status, HOLDS_TIME),
      onVisit(orgId, memberId),
      lt(sql`${visits.startAt} - ${visits.bufferBeforeMinutes} * interval '1 minute'`, window.endAt.toISOString()),
      gt(sql`${visits.endAt} + ${visits.bufferAfterMinutes} * interval '1 minute'`, window.startAt.toISOString()),
      ...(excludeVisitId ? [ne(visits.id, excludeVisitId)] : []),
    ],
    executor,
  );
  const blocks = await executor
    .select()
    .from(busyBlocks)
    .where(
      and(
        eq(busyBlocks.orgId, orgId),
        isNull(busyBlocks.cancelledAt),
        or(isNull(busyBlocks.memberId), eq(busyBlocks.memberId, memberId)),
        lt(busyBlocks.startAt, window.endAt),
        gt(busyBlocks.endAt, window.startAt),
      ),
    );
  return { visits: busyVisits, blocks };
}

/**
 * True when a day still fits with `minutes` more of work and driving in it: its work plus driving (`planDay`'s)
 * stays within the capacity's share of the working day. A day with no working hours fits nothing.
 */
export function fitsCapacity(plan: Pick<DayPlan, "workMinutes" | "driveMinutes" | "dayMinutes" | "capacityBp">, minutes: number): boolean {
  return plan.dayMinutes > 0 && (plan.workMinutes + plan.driveMinutes + minutes) * 10_000 <= plan.capacityBp * plan.dayMinutes;
}

/**
 * The order slots are offered in: those that fit the day's capacity first, then (`byDrive`) the least added
 * driving (unknown last), then the earliest. The sort is stable, so ties keep the order given.
 */
export function rankSlots<T extends Pick<Slot, "fits" | "addedDriveMinutes" | "startAt">>(slots: T[], byDrive: boolean): T[] {
  const drive = (slot: T) => (slot.addedDriveMinutes === null ? Number.POSITIVE_INFINITY : slot.addedDriveMinutes);
  return [...slots].sort(
    (a, b) =>
      Number(b.fits) - Number(a.fits) || (byDrive ? drive(a) - drive(b) : 0) || a.startAt.getTime() - b.startAt.getTime(),
  );
}

/**
 * Times a crew can take a visit of `durationMinutes` (plus buffers), from `from` for `days` days, in 15-minute
 * steps inside each one's working hours, around their visits and time off. Advisory: it holds nothing, and
 * booking checks again. With `memberIds` it's that crew; without, each active member on their own.
 *
 * Equipment: the work (its quote, or its job's, or the moved visit's) needs what its items need. Without
 * `memberIds`, members who don't carry all of it are left out. A crew named who don't carry it still get their
 * slots, with `missingEquipment` saying what they lack and `carriedBy` who carries it all; nobody is offered in
 * their place.
 *
 * The buffers not given are the drive to the work's property (`propertyId`, else the job's or quote's, else
 * the visit being moved's) from each one's stop before it that day or the yard, and on to the next stop or back.
 * When a place is unknown or unplaced, they fall back to the default and `driveEstimated` is false.
 *
 * Slots are ranked (`rankSlots`): those that keep everyone's day within the capacity first, then, when the work
 * and the yard are placed, the least driving added to the crew's day, then the earliest. `order: "time"` puts
 * them in time order instead. At most `limit` come back.
 */
export async function findAvailability(
  actor: Viewer,
  input: {
    memberIds?: string[];
    from: string;
    days?: number;
    durationMinutes?: number;
    bufferBeforeMinutes?: number;
    bufferAfterMinutes?: number;
    reschedulingVisitId?: string;
    propertyId?: string;
    jobId?: string;
    quoteId?: string;
    limit?: number;
    order?: "route" | "time";
  },
  deps?: { now?: Date },
): Promise<{
  timeZone: string;
  durationMinutes: number;
  slots: Slot[];
  driveEstimated: boolean;
  /** What the work needs; empty when nothing. */
  needs: string[];
  /** What the crew named don't carry between them; empty when they carry it all, or nobody was named. */
  missingEquipment: string[];
  /** With `missingEquipment`: the members who each carry all the work needs. */
  carriedBy: CrewRef[];
  advisory: true;
}> {
  const { orgId } = actor;
  const now = deps?.now ?? new Date();
  const profile = await getProfileWith(orgId, db());
  const timeZone = profile.timeZone;
  const named = input.memberIds ? await crewFor(orgId, input.memberIds, db()) : null;
  const team = await scheduleCrew(orgId, db());
  const duration = clampDuration(input.durationMinutes);
  const given = {
    before: input.bufferBeforeMinutes === undefined ? undefined : clampBuffer(input.bufferBeforeMinutes),
    after: input.bufferAfterMinutes === undefined ? undefined : clampBuffer(input.bufferAfterMinutes),
  };
  const days = Math.min(Math.max(Math.trunc(input.days ?? 7), 1), 14);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 60), 1), 100);
  const from = resolveDay(input.from, timeZone, now);
  let moving: VisitView | null = null;
  if (input.reschedulingVisitId) {
    moving = await getVisit(actor, input.reschedulingVisitId);
    if (!moving) throw new Error("VISIT_NOT_FOUND");
    if (!OPEN_VISIT.includes(moving.status)) throw new Error("VISIT_NOT_OPEN");
  }
  const work =
    (await workPlace(orgId, input, db())) ??
    (moving?.propertyId ? { propertyId: moving.propertyId, place: moving.place } : null);
  const target = work?.place ?? null;
  const jobId = input.jobId ?? moving?.jobId;
  const job = !input.quoteId && jobId ? await jobRow(orgId, jobId, db()) : null;
  const needs = await equipmentNeeded(orgId, input.quoteId ?? job?.quoteId ?? moving?.quoteId, db());
  const lacking = named ? missingEquipment(needs, named.map((m) => m.equipment)) : [];
  const crews: CrewMember[][] = named ? [named] : team.filter((m) => carriesAll(needs, [m.equipment])).map((m) => [m]);
  const yard = yardOf(profile);
  const settings = driveSettingsOf(profile);
  // Insertion math needs both ends of the day placed; without them, slots go in time order.
  const byDrive = (input.order ?? "route") === "route" && target !== null && yard !== null;
  const window = { startAt: new Date(dayStart(from, timeZone).getTime() - DAY), endAt: new Date(dayStart(addDays(from, days), timeZone).getTime() + DAY) };
  const busy = new Map<string, Interval[]>();
  // Each one's visits by local day: their stops, for the drives in and out of a slot, and their day's plan.
  const visitsByDay = new Map<string, Map<string, VisitView[]>>();
  for (const member of new Map(crews.flat().map((m) => [m.memberId, m])).values()) {
    const taken = await occupancy(orgId, member.memberId, window, db(), input.reschedulingVisitId);
    busy.set(member.memberId, [...taken.visits.map(occupiedInterval), ...taken.blocks]);
    const byDay = new Map<string, VisitView[]>();
    for (const v of taken.visits) {
      const date = wallClock(v.startAt, timeZone).date;
      byDay.set(date, [...(byDay.get(date) ?? []), v]);
    }
    visitsByDay.set(member.memberId, byDay);
  }
  const dayVisits = (member: CrewMember, date: string) => visitsByDay.get(member.memberId)?.get(date) ?? [];
  const plans = new Map<string, DayPlan>();
  const planOf = (member: CrewMember, date: string) => {
    const key = `${member.memberId}:${date}`;
    if (!plans.has(key)) {
      const { memberId, name, hours } = member;
      plans.set(key, planDay({ memberId, name, date, hours, yard, settings, capacityBp: profile.capacityBp, visits: dayVisits(member, date) }));
    }
    return plans.get(key)!;
  };
  const found: Slot[] = [];
  for (let d = 0; d < days; d++) {
    const date = addDays(from, d);
    for (const crew of crews) {
      const starts = new Set<number>();
      for (const member of crew) for (const s of workingSegments(date, member.hours)) for (let m = s.start; m < s.end; m += 15) starts.add(m);
      for (const minute of [...starts].sort((a, b) => a - b)) {
        for (const startAt of localTimeInstants(date, minutesClock(minute), timeZone)) {
          if (startAt <= now) continue;
          const endAt = new Date(startAt.getTime() + duration * MINUTE);
          const at = { startAt, place: target };
          const crewStops = crew.map((member) => dayVisits(member, date).map(stopOf));
          const drives = crewDrives(at, crewStops, yard, settings);
          const buffers = visitBuffers(given, drives);
          const held = occupiedInterval({ startAt, endAt, ...buffers });
          const free = crew.every(
            (member) =>
              withinWorkingHours(held.startAt, held.endAt, timeZone, member.hours) &&
              !(busy.get(member.memberId) ?? []).some((taken) => intervalsOverlap(held, taken)),
          );
          if (!free) continue;
          const added = byDrive ? crewAddedDrive(at, crewStops, yard, settings) : null;
          found.push({
            date,
            start: wallClock(startAt, timeZone).time,
            end: wallClock(endAt, timeZone).time,
            startAt,
            endAt,
            offsetMinutes: offsetMinutesAt(startAt, timeZone),
            crew: crew.map(({ memberId, name }) => ({ memberId, name })),
            driveFromPreviousMinutes: drives.before,
            driveToNextMinutes: drives.after,
            driveEstimated: buffers.driveEstimated,
            addedDriveMinutes: added,
            fits: crew.every((member) => fitsCapacity(planOf(member, date), duration + (added ?? 0))),
          });
        }
      }
    }
  }
  const ordered = input.order === "time" ? [...found].sort((a, b) => a.startAt.getTime() - b.startAt.getTime()) : rankSlots(found, byDrive);
  const slots = ordered.slice(0, limit);
  const driveEstimated = slots.length ? slots.every((slot) => slot.driveEstimated) : target !== null && yard !== null;
  const carriedBy = lacking.length ? team.filter((m) => carriesAll(needs, [m.equipment])).map(({ memberId, name }) => ({ memberId, name })) : [];
  return { timeZone, durationMinutes: duration, slots, driveEstimated, needs, missingEquipment: lacking, carriedBy, advisory: true };
}

/** The first names of a crew, as `confirmText` says them: "Carlos", "Carlos and Ana". */
function crewNames(crew: CrewRef[], language: Language): string {
  const names = crew.map((c) => c.name.split(/\s+/)[0]);
  const and = language === "es" ? " y " : " and ";
  return names.length > 1 ? `${names.slice(0, -1).join(", ")}${and}${names.at(-1)}` : (names[0] ?? "");
}

const SLOT_WORDS: Record<Language, { with: string; driving: (minutes: number) => string; full: string }> = {
  en: { with: "with", driving: (minutes) => `+${minutes} min driving`, full: "day would be over capacity" },
  es: { with: "con", driving: (minutes) => `+${minutes} min de manejo`, full: "el día pasaría de la capacidad" },
};

/** A slot as the member reads it: "Tue, Nov 3, 9 AM with Carlos (+10 min driving)", and when it doesn't fit, "(day would be over capacity)". */
export function slotLine(slot: Slot, timeZone: string, language: Language): string {
  const words = SLOT_WORDS[language];
  const notes = [
    ...(slot.addedDriveMinutes !== null ? [words.driving(slot.addedDriveMinutes)] : []),
    ...(slot.fits ? [] : [words.full]),
  ];
  const when = `${dayText(slot.date, language)}, ${timeText(slot.startAt, timeZone, language)}`;
  return `${when} ${words.with} ${crewNames(slot.crew, language)}${notes.length ? ` (${notes.join("; ")})` : ""}`;
}

/** Two offers on one crew's day sit at least this far apart, so three lines aren't three quarter-hours of one morning. */
const OFFER_GAP_MS = 2 * 60 * 60 * 1000;

/**
 * The few slots to offer, as lines: the best-ranked one for each crew and day, in rank order, so the offer is a
 * spread rather than the first minutes of one morning. When that leaves fewer than `count` (one crew asked
 * about one day), the next-ranked slots fill in, each a couple of hours from the others on its day.
 */
export function slotLines(slots: Slot[], timeZone: string, language: Language, count = 3): string[] {
  const seen = new Set<string>();
  const chosen: Slot[] = [];
  const keyOf = (slot: Slot) => `${slot.crew.map((c) => c.memberId).join("+")}:${slot.date}`;
  for (const slot of slots) {
    const key = keyOf(slot);
    if (seen.has(key)) continue;
    seen.add(key);
    chosen.push(slot);
    if (chosen.length >= count) break;
  }
  for (const slot of slots) {
    if (chosen.length >= count) break;
    if (chosen.includes(slot)) continue;
    const key = keyOf(slot);
    const crowded = chosen.some((c) => keyOf(c) === key && Math.abs(c.startAt.getTime() - slot.startAt.getTime()) < OFFER_GAP_MS);
    if (!crowded) chosen.push(slot);
  }
  return chosen.map((slot) => slotLine(slot, timeZone, language));
}

const DAY = 24 * 60 * MINUTE;

function clampDuration(minutes: number | undefined): number {
  const value = minutes ?? DEFAULT_VISIT_MINUTES;
  if (!Number.isInteger(value) || value < 15 || value > 16 * 60) throw new Error("INVALID_DURATION");
  return value;
}

function clampBuffer(minutes: number | undefined): number {
  const value = minutes ?? 0;
  if (!Number.isInteger(value) || value < 0 || value > 480) throw new Error("INVALID_BUFFER");
  return value;
}

/**
 * Refuses a time the crew can't take: outside anyone's hours (unless `allowOutsideHours`), over one of
 * their visits, or in their time off. The messages name who and what, for the model to say.
 */
async function ensureCrewFree(
  orgId: string,
  crew: CrewMember[],
  candidate: { startAt: Date; endAt: Date; bufferBeforeMinutes: number; bufferAfterMinutes: number },
  timeZone: string,
  executor: Db | Tx,
  options: { allowOutsideHours?: boolean; excludeVisitId?: string; language: Language },
): Promise<void> {
  const held = occupiedInterval(candidate);
  if (!options.allowOutsideHours) {
    const outside = crew.filter((c) => !withinWorkingHours(held.startAt, held.endAt, timeZone, c.hours));
    if (outside.length) {
      const date = wallClock(candidate.startAt, timeZone).date;
      const hours = outside
        .map((c) => {
          const segments = workingSegments(date, c.hours);
          return `${c.name} works ${segments.length ? segments.map((s) => `${minutesClock(s.start)}-${minutesClock(s.end)}`).join(", ") : "no hours"} that day`;
        })
        .join("; ");
      throw new Error(`OUTSIDE_HOURS: ${hours}`);
    }
  }
  for (const member of crew) {
    const taken = await occupancy(orgId, member.memberId, held, executor, options.excludeVisitId);
    const clash = taken.visits.find((v) => intervalsOverlap(held, occupiedInterval(v)));
    if (clash) {
      throw new Error(`CREW_BUSY: ${member.name} has ${clash.title} ${whenText(clash.startAt, clash.endAt, timeZone, "en")}`);
    }
    const off = taken.blocks.find((b) => intervalsOverlap(held, b));
    if (off) throw new Error(`CREW_OFF: ${member.memberId === off.memberId ? member.name : "The business"} is off then${off.reason ? ` (${off.reason})` : ""}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Jobs

export type ServiceJobView = ServiceJob & { customerName: string | null; address: string | null; visits: VisitView[] };

async function jobRow(orgId: string, jobId: string, executor: Db | Tx): Promise<ServiceJob | null> {
  const [row] = await executor.select().from(serviceJobs).where(and(eq(serviceJobs.orgId, orgId), eq(serviceJobs.id, jobId)));
  return row ?? null;
}

/** The quote's job that isn't cancelled, if it has one. */
async function jobForQuote(orgId: string, quoteId: string, executor: Db | Tx): Promise<ServiceJob | null> {
  const [row] = await executor
    .select()
    .from(serviceJobs)
    .where(and(eq(serviceJobs.orgId, orgId), eq(serviceJobs.quoteId, quoteId), ne(serviceJobs.status, "cancelled")));
  return row ?? null;
}

type JobInput = {
  quoteId?: string;
  customerId?: string;
  propertyId?: string;
  title?: string;
  notes?: string;
  /** The work repeats: its weekday, clock, and length come from its first visit (`fromVisit`). */
  recurring?: Recurring;
};

/** A recurrence's weekday, clock, and length from a visit: what repeats, when it wasn't given. */
function fromVisit(recurrence: Pick<Recurrence, "every">, visit: { startAt: Date; endAt: Date }, timeZone: string): Recurrence {
  const local = wallClock(visit.startAt, timeZone);
  return {
    every: recurrence.every,
    weekday: weekdayOf(local.date),
    time: local.time,
    durationMinutes: Math.round((visit.endAt.getTime() - visit.startAt.getTime()) / MINUTE),
  };
}

/**
 * Finds or makes the job. From a quote, the quote must be approved, sent, or won (the money is agreed),
 * and it has one job: a second call returns it. Otherwise it needs a title, and a customer and property
 * when given must be this business's and each other's.
 */
async function ensureJob(actor: Actor, input: JobInput, tx: Tx, now: Date): Promise<{ job: ServiceJob; created: boolean }> {
  const { orgId } = actor;
  if (input.quoteId) {
    const [quote] = await tx.select().from(quotes).where(and(eq(quotes.orgId, orgId), eq(quotes.id, input.quoteId)));
    if (!quote) throw new Error("QUOTE_NOT_FOUND");
    const existing = await jobForQuote(orgId, quote.id, tx);
    if (existing) {
      if (existing.status !== "open") throw new Error("JOB_CLOSED");
      return { job: existing, created: false };
    }
    if (!(AGREED_QUOTE as readonly string[]).includes(quote.status)) throw new Error(`QUOTE_NOT_AGREED: it is ${quote.status}`);
    const [job] = await tx
      .insert(serviceJobs)
      .values({
        id: newId("sj"),
        orgId,
        title: input.title?.trim() || quote.title,
        customerId: quote.customerId,
        propertyId: quote.propertyId,
        quoteId: quote.id,
        quoteRevisionId: quote.currentRevisionId,
        notes: input.notes?.trim() || null,
        recurrence: input.recurring ? { every: everyOf(input.recurring) } : null,
        createdByMemberId: actor.memberId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await recordEvent({ orgId, kind: "service_job.created", refId: job.id, memberId: actor.memberId, data: { quoteId: quote.id } }, tx);
    return { job, created: true };
  }
  const title = input.title?.trim();
  if (!title) throw new Error("JOB_TITLE_REQUIRED");
  if (input.customerId) {
    const [customer] = await tx.select({ id: customers.id }).from(customers).where(and(eq(customers.orgId, orgId), eq(customers.id, input.customerId)));
    if (!customer) throw new Error("CUSTOMER_NOT_FOUND");
  }
  if (input.propertyId) {
    const [property] = await tx.select().from(properties).where(and(eq(properties.orgId, orgId), eq(properties.id, input.propertyId)));
    if (!property) throw new Error("PROPERTY_NOT_FOUND");
    if (property.customerId !== input.customerId) throw new Error("PROPERTY_MISMATCH");
  }
  const [job] = await tx
    .insert(serviceJobs)
    .values({
      id: newId("sj"),
      orgId,
      title,
      customerId: input.customerId ?? null,
      propertyId: input.propertyId ?? null,
      notes: input.notes?.trim() || null,
      recurrence: input.recurring ? { every: everyOf(input.recurring) } : null,
      createdByMemberId: actor.memberId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await recordEvent({ orgId, kind: "service_job.created", refId: job.id, memberId: actor.memberId }, tx);
  return { job, created: true };
}

/**
 * Opens a job without booking it yet: from a quote (`quoteId`) or on its own (`title`). Owners and admins.
 * `recurring` on the quote's job it already has sets how it repeats, from its next visit when it has one.
 */
export async function createServiceJob(actor: Actor, input: JobInput, deps?: Deps): Promise<{ job: ServiceJobView; created: boolean }> {
  requirePrivileged(actor);
  const now = deps?.now ?? new Date();
  const { job, created } = await db().transaction(async (tx) => {
    await lockSchedule(tx, actor.orgId);
    const made = await ensureJob(actor, input, tx, now);
    if (!made.created && input.recurring) await recordRecurrence(tx, actor, made.job, input.recurring, now);
    return made;
  });
  return { job: (await getServiceJob(actor, job.id)) as ServiceJobView, created };
}

/**
 * Sets how a job repeats, or (`none`) stops it repeating. A job already repeating keeps its weekday, clock, and
 * length when only how often changes; otherwise they come from its next open visit, else its last one, else
 * its first visit to be booked.
 */
async function recordRecurrence(tx: Tx, actor: Actor, job: ServiceJob, recurring: Recurring | "none", now: Date): Promise<Recurrence | null> {
  const { orgId } = actor;
  let recurrence: Recurrence | null = null;
  if (recurring !== "none") {
    const every = everyOf(recurring);
    if (job.recurrence?.weekday !== undefined) {
      recurrence = { ...job.recurrence, every };
    } else {
      const timeZone = (await getProfileWith(orgId, tx)).timeZone;
      const booked = await loadVisitViews(orgId, [eq(visits.jobId, job.id), ne(visits.status, "cancelled")], tx);
      const visit = booked.find((v) => OPEN_VISIT.includes(v.status)) ?? booked.at(-1);
      recurrence = visit ? fromVisit({ every }, visit, timeZone) : { every };
    }
  }
  await tx.update(serviceJobs).set({ recurrence, updatedAt: now }).where(and(eq(serviceJobs.orgId, orgId), eq(serviceJobs.id, job.id)));
  await recordEvent({ orgId, kind: "service_job.recurrence", refId: job.id, memberId: actor.memberId, data: { recurrence } }, tx);
  return recurrence;
}

/**
 * Sets how open work repeats ("weekly", "biweekly", "monthly"), or stops it ("none"), owners and admins only. The
 * visits already booked stay: returns the work and its next open visit, for the member to be asked about it.
 */
export async function setRecurrence(
  actor: Actor,
  input: { jobId: string; recurring: Recurring | "none" },
  deps?: Deps,
): Promise<{ job: ServiceJobView; nextVisit: VisitView | null }> {
  requirePrivileged(actor);
  const now = deps?.now ?? new Date();
  await db().transaction(async (tx) => {
    await lockSchedule(tx, actor.orgId);
    const job = await jobRow(actor.orgId, input.jobId, tx);
    if (!job) throw new Error("SERVICE_JOB_NOT_FOUND");
    if (job.status !== "open") throw new Error("JOB_CLOSED");
    await recordRecurrence(tx, actor, job, input.recurring, now);
  });
  const job = (await getServiceJob(actor, input.jobId)) as ServiceJobView;
  return { job, nextVisit: job.visits.find((v) => OPEN_VISIT.includes(v.status)) ?? null };
}

/** A job with its visits. */
export async function getServiceJob(viewer: Viewer, jobId: string): Promise<ServiceJobView | null> {
  const { orgId } = viewer;
  const [row] = await db()
    .select({ job: serviceJobs, customerName: customers.name, address: properties.address })
    .from(serviceJobs)
    .leftJoin(customers, and(eq(customers.orgId, orgId), eq(customers.id, serviceJobs.customerId)))
    .leftJoin(properties, and(eq(properties.orgId, orgId), eq(properties.id, serviceJobs.propertyId)))
    .where(and(eq(serviceJobs.orgId, orgId), eq(serviceJobs.id, jobId)));
  if (!row) return null;
  const jobVisits = await loadVisitViews(orgId, [eq(visits.jobId, jobId)]);
  return { ...row.job, customerName: row.customerName, address: row.address, visits: jobVisits };
}

/**
 * How a job repeats, in a line ("Every week on Tuesdays at 9 AM"); null for one-off work. A monthly one's weekday
 * of the month is its next open visit's, else its last one's.
 */
export function jobRecurrenceText(job: Pick<ServiceJobView, "recurrence" | "visits">, timeZone: string, language: Language): string | null {
  if (!job.recurrence) return null;
  const live = job.visits.filter((v) => v.status !== "cancelled");
  const visit = live.find((v) => OPEN_VISIT.includes(v.status)) ?? live.at(-1);
  return recurrenceText(job.recurrence, language, visit ? wallClock(visit.startAt, timeZone).date : undefined);
}

/** The jobs on a quote or a customer, newest first, each with its visits. */
export async function serviceJobsAbout(viewer: Viewer, about: { quoteId: string } | { customerId: string }): Promise<ServiceJobView[]> {
  const { orgId } = viewer;
  const rows = await db()
    .select({ id: serviceJobs.id })
    .from(serviceJobs)
    .where(
      and(
        eq(serviceJobs.orgId, orgId),
        "quoteId" in about ? eq(serviceJobs.quoteId, about.quoteId) : eq(serviceJobs.customerId, about.customerId),
      ),
    )
    .orderBy(desc(serviceJobs.createdAt), desc(serviceJobs.id));
  const out: ServiceJobView[] = [];
  for (const { id } of rows) {
    const job = await getServiceJob(viewer, id);
    if (job) out.push(job);
  }
  return out;
}

export type ToSchedule =
  | { kind: "quote"; quoteId: string; title: string; customerName: string | null; address: string | null; since: Date }
  | {
      kind: "job";
      jobId: string;
      quoteId: string | null;
      title: string;
      customerName: string | null;
      address: string | null;
      since: Date;
      recurrence: Recurrence | null;
    };

/**
 * Work waiting for a visit, oldest first: won quotes with no job yet, and open jobs with no visit
 * booked or pencilled in. Owners and admins plan the schedule, so this is theirs.
 */
export async function toSchedule(orgId: string): Promise<ToSchedule[]> {
  const won = await db()
    .select({ quote: quotes, customerName: customers.name, address: properties.address })
    .from(quotes)
    .leftJoin(customers, and(eq(customers.orgId, orgId), eq(customers.id, quotes.customerId)))
    .leftJoin(properties, and(eq(properties.orgId, orgId), eq(properties.id, quotes.propertyId)))
    .where(
      and(
        eq(quotes.orgId, orgId),
        eq(quotes.status, "won"),
        notExists(
          db()
            .select({ id: serviceJobs.id })
            .from(serviceJobs)
            .where(and(eq(serviceJobs.orgId, orgId), eq(serviceJobs.quoteId, quotes.id), ne(serviceJobs.status, "cancelled"))),
        ),
      ),
    );
  const idle = await db()
    .select({ job: serviceJobs, customerName: customers.name, address: properties.address })
    .from(serviceJobs)
    .leftJoin(customers, and(eq(customers.orgId, orgId), eq(customers.id, serviceJobs.customerId)))
    .leftJoin(properties, and(eq(properties.orgId, orgId), eq(properties.id, serviceJobs.propertyId)))
    .where(
      and(
        eq(serviceJobs.orgId, orgId),
        eq(serviceJobs.status, "open"),
        notExists(
          db()
            .select({ id: visits.id })
            .from(visits)
            .where(and(eq(visits.orgId, orgId), eq(visits.jobId, serviceJobs.id), inArray(visits.status, OPEN_VISIT))),
        ),
      ),
    );
  const items: ToSchedule[] = [
    ...won.map(({ quote, customerName, address }) => ({
      kind: "quote" as const,
      quoteId: quote.id,
      title: quote.title,
      customerName,
      address,
      since: quote.outcomeAt ?? quote.updatedAt,
    })),
    ...idle.map(({ job, customerName, address }) => ({
      kind: "job" as const,
      jobId: job.id,
      quoteId: job.quoteId,
      title: job.title,
      customerName,
      address,
      since: job.createdAt,
      recurrence: job.recurrence ?? null,
    })),
  ];
  return items.sort((a, b) => a.since.getTime() - b.since.getTime());
}

// ---------------------------------------------------------------------------------------------
// Booking, moving, finishing

async function saveRevision(tx: Tx, actor: Actor, visitId: string, action: string, reason: string | null | undefined): Promise<void> {
  const [row] = await tx.select().from(visits).where(and(eq(visits.orgId, actor.orgId), eq(visits.id, visitId)));
  const crew = (await crewOf(actor.orgId, [visitId], tx)).get(visitId) ?? [];
  await tx.insert(visitRevisions).values({
    id: newId("vr"),
    orgId: actor.orgId,
    visitId,
    revision: row.revision,
    action,
    reason: reason?.trim() || null,
    snapshot: JSON.parse(JSON.stringify({ ...row, crew: crew.map((c) => c.memberId) })),
    memberId: actor.memberId,
  });
  await recordEvent({ orgId: actor.orgId, kind: `visit.${action}`, refId: visitId, memberId: actor.memberId, data: { jobId: row.jobId } }, tx);
}

/** Refuses a crew who don't carry what the work needs between them. Throws `MISSING_EQUIPMENT`. */
async function ensureCrewCarries(orgId: string, quoteId: string | null, crew: CrewMember[], tx: Tx): Promise<void> {
  const lacking = missingEquipment(await equipmentNeeded(orgId, quoteId, tx), crew.map((c) => c.equipment));
  if (!lacking.length) return;
  const names = crew.map((c) => c.name);
  const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)} don't` : `${names[0]} doesn't`;
  throw new Error(`MISSING_EQUIPMENT: ${who} carry ${lacking.join(", ")}, which the work needs`);
}

export type BookVisitInput = JobInput & {
  /** An open job to add the visit to. Otherwise the quote's job (made if needed), or a new job. */
  jobId?: string;
  memberIds: string[];
  /** `YYYY-MM-DD`, "today", "tomorrow", or a weekday, in the business's time zone. */
  day: string;
  /** 24-hour `HH:MM`, local. */
  time: string;
  /** Only for a time the fall-back hour repeats: which of the two. */
  offsetMinutes?: number;
  durationMinutes?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  visitNotes?: string;
  /** Pencilled in: `proposed`, which still holds the time. */
  tentative?: boolean;
  /** Books without texting the crew: a forwarded email's turn (core/email-intake.ts) reaches nobody but its member. */
  silent?: boolean;
  /** The owner means it: book outside the crew's working hours. */
  allowOutsideHours?: boolean;
  /** The owner means it: book a crew who don't carry what the work needs ("Carlos will borrow the chipper"). */
  allowMissingEquipment?: boolean;
  /** Recurring work's next visit (`rollForward`): refused with `NEXT_ALREADY_BOOKED` when the job has one open already. */
  nextOfRecurring?: boolean;
};

export type BookingResult = {
  visit: VisitView;
  jobCreated: boolean;
  timeZone: string;
  notified: string[];
  /** Booking only: false when a buffer fell back to the default because a place was unplaced or unknown. */
  driveEstimated?: boolean;
};

/**
 * Books a visit, owners and admins only. Refuses a past time, a crew who don't carry what the work needs (unless
 * `allowMissingEquipment`), a time outside the crew's hours (unless `allowOutsideHours`), and one over their
 * other visits or time off. Texts each crew member booked,
 * other than whoever booked it. The buffers not given are the drives in and out (`findAvailability`), to
 * the property given or the work's. With `recurring`, the work repeats from this visit: its weekday, clock, and
 * length.
 */
export async function bookVisit(actor: Actor, input: BookVisitInput, deps?: Deps): Promise<BookingResult> {
  requirePrivileged(actor);
  const { orgId } = actor;
  const now = deps?.now ?? new Date();
  const result = await db().transaction(async (tx) => {
    await lockSchedule(tx, orgId);
    const profile = await getProfileWith(orgId, tx);
    const timeZone = profile.timeZone;
    const { startAt, endAt } = visitTimes(input, timeZone, now);
    const crew = await crewFor(orgId, input.memberIds, tx);
    const given = {
      before: input.bufferBeforeMinutes === undefined ? undefined : clampBuffer(input.bufferBeforeMinutes),
      after: input.bufferAfterMinutes === undefined ? undefined : clampBuffer(input.bufferAfterMinutes),
    };
    let job: ServiceJob;
    let jobCreated = false;
    if (input.jobId) {
      const found = await jobRow(orgId, input.jobId, tx);
      if (!found) throw new Error("SERVICE_JOB_NOT_FOUND");
      if (found.status !== "open") throw new Error("JOB_CLOSED");
      job = found;
    } else {
      ({ job, created: jobCreated } = await ensureJob(actor, input, tx, now));
    }
    if (input.nextOfRecurring) {
      const [open] = await tx
        .select({ id: visits.id })
        .from(visits)
        .where(and(eq(visits.orgId, orgId), eq(visits.jobId, job.id), inArray(visits.status, OPEN_VISIT)))
        .limit(1);
      if (open) throw new Error("NEXT_ALREADY_BOOKED");
    }
    if (!input.allowMissingEquipment) await ensureCrewCarries(orgId, job.quoteId, crew, tx);
    const work = await workPlace(orgId, { propertyId: input.propertyId ?? job.propertyId ?? undefined }, tx);
    const crewStops = await crewStopsOn(orgId, crew, wallClock(startAt, timeZone).date, timeZone, tx);
    const { driveEstimated, ...buffers } = visitBuffers(
      given,
      crewDrives({ startAt, place: work?.place ?? null }, crewStops, yardOf(profile), driveSettingsOf(profile)),
    );
    const { bufferBeforeMinutes, bufferAfterMinutes } = buffers;
    await ensureCrewFree(orgId, crew, { startAt, endAt, bufferBeforeMinutes, bufferAfterMinutes }, timeZone, tx, {
      allowOutsideHours: input.allowOutsideHours,
      language: actor.language,
    });
    const id = newId("vis");
    await tx.insert(visits).values({
      id,
      orgId,
      jobId: job.id,
      startAt,
      endAt,
      bufferBeforeMinutes,
      bufferAfterMinutes,
      status: input.tentative ? "proposed" : "scheduled",
      notes: input.visitNotes?.trim() || null,
      createdByMemberId: actor.memberId,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(visitCrew).values(crew.map((c) => ({ orgId, visitId: id, memberId: c.memberId })));
    // Work made recurring here, or recurring with no visit yet, repeats from this one; one only pencilled in
    // isn't the time agreed yet.
    const recurrence = input.recurring
      ? fromVisit({ every: everyOf(input.recurring) }, { startAt, endAt }, timeZone)
      : job.recurrence && job.recurrence.weekday === undefined && !input.tentative
        ? fromVisit(job.recurrence, { startAt, endAt }, timeZone)
        : null;
    await tx
      .update(serviceJobs)
      .set({ updatedAt: now, ...(recurrence ? { recurrence } : {}) })
      .where(and(eq(serviceJobs.orgId, orgId), eq(serviceJobs.id, job.id)));
    await saveRevision(tx, actor, id, "booked", null);
    return { id, jobCreated, timeZone, driveEstimated };
  });
  const brief = await crewBrief(orgId, result.id);
  const visit = await visitWithDrives(actor, result.id);
  const notified = input.silent
    ? []
    : await tellCrew(actor, visit.crew.map((c) => c.memberId), (lang) => withChecklist(crewText.booked(actor.name, visit, result.timeZone, lang), brief, lang), deps, brief);
  return { visit, jobCreated: result.jobCreated, timeZone: result.timeZone, notified, driveEstimated: result.driveEstimated };
}

/** A visit just booked or moved, with its drives. */
async function visitWithDrives(viewer: Viewer, visitId: string): Promise<VisitView> {
  const visit = (await getVisit(viewer, visitId)) as VisitView;
  const [withDrive] = await withDrives(viewer.orgId, [visit], await getProfileWith(viewer.orgId, db()));
  return withDrive;
}

function visitTimes(
  input: { day: string; time: string; offsetMinutes?: number; durationMinutes?: number },
  timeZone: string,
  now: Date,
): { startAt: Date; endAt: Date; date: string } {
  const date = resolveDay(input.day, timeZone, now);
  const startAt = resolveLocalTime(date, input.time, timeZone, input.offsetMinutes);
  const endAt = new Date(startAt.getTime() + clampDuration(input.durationMinutes) * MINUTE);
  if (startAt <= now) throw new Error(`VISIT_IN_PAST: ${date} ${input.time} has already passed`);
  return { startAt, endAt, date };
}

export type RescheduleInput = {
  visitId: string;
  day?: string;
  time?: string;
  offsetMinutes?: number;
  durationMinutes?: number;
  memberIds?: string[];
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  visitNotes?: string;
  reason?: string;
  allowOutsideHours?: boolean;
  /** The owner means it: send a crew who don't carry what the work needs. */
  allowMissingEquipment?: boolean;
};

/**
 * Moves a visit, changes how long it is, or changes who goes, owners and admins only. Whatever isn't
 * given stays as it was. The same checks as booking apply, leaving the visit's own time out; what the work
 * needs is checked when the crew changes, since the crew it has were already booked on it. Texts whoever is
 * on it before or after, other than whoever moved it.
 */
export async function rescheduleVisit(actor: Actor, input: RescheduleInput, deps?: Deps): Promise<BookingResult & { previous: VisitView }> {
  requirePrivileged(actor);
  const now = deps?.now ?? new Date();
  const moved = await db().transaction(async (tx) => {
    await lockSchedule(tx, actor.orgId);
    return moveVisitIn(tx, actor, input, now);
  });
  return tellMoved(actor, moved.previous, moved.timeZone, deps);
}

/**
 * `rescheduleVisit`'s change, inside a transaction that holds the schedule's lock (`lockSchedule`): the checks
 * and the write, no texts. With `revision`, a visit changed since then is refused (`REVISION_CHANGED`). Returns
 * the visit as it was, for `tellMoved` once the transaction commits.
 */
export async function moveVisitIn(tx: Tx, actor: Actor, input: RescheduleInput & { revision?: number }, now: Date): Promise<{ previous: VisitView; timeZone: string }> {
  requirePrivileged(actor);
  const { orgId } = actor;
  const before = await getVisit(actor, input.visitId, tx);
  if (!before) throw new Error("VISIT_NOT_FOUND");
  if (!OPEN_VISIT.includes(before.status)) throw new Error(`VISIT_NOT_OPEN: it is ${before.status}`);
  if (before.jobStatus !== "open") throw new Error("JOB_CLOSED");
  if (input.revision !== undefined && before.revision !== input.revision) throw new Error("REVISION_CHANGED");
  const timeZone = (await getProfileWith(orgId, tx)).timeZone;
  const local = wallClock(before.startAt, timeZone);
  const minutes = Math.round((before.endAt.getTime() - before.startAt.getTime()) / MINUTE);
  const keepsTime = input.day === undefined && input.time === undefined;
  const { startAt, endAt } = keepsTime && input.durationMinutes === undefined
    ? { startAt: before.startAt, endAt: before.endAt }
    : keepsTime
      ? { startAt: before.startAt, endAt: new Date(before.startAt.getTime() + clampDuration(input.durationMinutes) * MINUTE) }
      : visitTimes(
          { day: input.day ?? local.date, time: input.time ?? local.time, offsetMinutes: input.offsetMinutes, durationMinutes: input.durationMinutes ?? minutes },
          timeZone,
          now,
        );
  if (startAt <= now && !keepsTime) throw new Error("VISIT_IN_PAST");
  const crew = await crewFor(orgId, input.memberIds ?? before.crew.map((c) => c.memberId), tx);
  const newCrew = crew.some((c) => !before.crew.some((b) => b.memberId === c.memberId));
  if (newCrew && !input.allowMissingEquipment) await ensureCrewCarries(orgId, before.quoteId, crew, tx);
  const bufferBeforeMinutes = input.bufferBeforeMinutes === undefined ? before.bufferBeforeMinutes : clampBuffer(input.bufferBeforeMinutes);
  const bufferAfterMinutes = input.bufferAfterMinutes === undefined ? before.bufferAfterMinutes : clampBuffer(input.bufferAfterMinutes);
  await ensureCrewFree(orgId, crew, { startAt, endAt, bufferBeforeMinutes, bufferAfterMinutes }, timeZone, tx, {
    allowOutsideHours: input.allowOutsideHours,
    excludeVisitId: before.visitId,
    language: actor.language,
  });
  await tx
    .update(visits)
    .set({
      startAt,
      endAt,
      bufferBeforeMinutes,
      bufferAfterMinutes,
      ...(input.visitNotes !== undefined ? { notes: input.visitNotes.trim() || null } : {}),
      revision: sql`${visits.revision} + 1`,
      updatedAt: now,
    })
    .where(and(eq(visits.orgId, orgId), eq(visits.id, before.visitId)));
  await tx.delete(visitCrew).where(and(eq(visitCrew.orgId, orgId), eq(visitCrew.visitId, before.visitId)));
  await tx.insert(visitCrew).values(crew.map((c) => ({ orgId, visitId: before.visitId, memberId: c.memberId })));
  await saveRevision(tx, actor, before.visitId, "rescheduled", input.reason);
  return { previous: before, timeZone };
}

/**
 * The texts after a move (`moveVisitIn`) commits: crew new on the visit are booked on it with its checklist,
 * crew who stay hear the new time when it moved, and crew taken off hear so. Returns the visit as it is now.
 */
export async function tellMoved(actor: Actor, previous: VisitView, timeZone: string, deps?: Deps): Promise<BookingResult & { previous: VisitView }> {
  const visit = await visitWithDrives(actor, previous.visitId);
  const now_ = visit.crew.map((c) => c.memberId);
  const joined = now_.filter((id) => !previous.crew.some((c) => c.memberId === id));
  // Crew new on the visit get its checklist and priced photo, as a booking would send them.
  const brief = joined.length ? await crewBrief(actor.orgId, previous.visitId) : null;
  const moved = previous.startAt.getTime() !== visit.startAt.getTime() || previous.endAt.getTime() !== visit.endAt.getTime();
  const text = (lang: Language) =>
    previous.crew.some((c) => now_.includes(c.memberId)) && moved ? crewText.moved(actor.name, visit, timeZone, lang) : crewText.booked(actor.name, visit, timeZone, lang);
  const notified = [
    ...(await tellCrew(actor, joined, (lang) => withChecklist(text(lang), brief, lang), deps, brief)),
    ...(moved ? await tellCrew(actor, now_.filter((id) => !joined.includes(id)), text, deps) : []),
    ...(await tellCrew(
      actor,
      previous.crew.map((c) => c.memberId).filter((id) => !now_.includes(id)),
      (lang) => crewText.removed(actor.name, previous, timeZone, lang),
      deps,
    )),
  ];
  return { visit, previous, jobCreated: false, timeZone, notified };
}

/**
 * Marks a visit done, cancels it, or confirms one pencilled in. Anyone on the team marks a visit done
 * once its day has come (someone may finish another crew's job); everything else is for owners and admins. A cancelled visit's crew
 * get a text. Recurring work done gets its next visit (`rollForward`), returned as `nextVisit`. Returns how many
 * visits the job still has open, so the member can be asked about closing it.
 */
export async function changeVisitStatus(
  actor: Actor,
  input: { visitId: string; status: "completed" | "cancelled" | "scheduled"; reason?: string; visitNotes?: string },
  deps?: Deps,
): Promise<{ visit: VisitView; openVisitsOnJob: number; notified: string[]; nextVisit: VisitView | null }> {
  const { orgId } = actor;
  const now = deps?.now ?? new Date();
  if (input.status !== "completed") requirePrivileged(actor);
  const timeZone = await db().transaction(async (tx) => {
    await lockSchedule(tx, orgId);
    const before = await getVisit(actor, input.visitId, tx);
    if (!before) throw new Error("VISIT_NOT_FOUND");
    const tz = (await getProfileWith(orgId, tx)).timeZone;
    if (input.status === "scheduled") {
      if (before.status !== "proposed") throw new Error(`VISIT_NOT_PROPOSED: it is ${before.status}`);
    } else if (!OPEN_VISIT.includes(before.status)) {
      throw new Error(`VISIT_NOT_OPEN: it is ${before.status}`);
    }
    if (input.status === "completed" && wallClock(before.startAt, tz).date > wallClock(now, tz).date) {
      throw new Error("VISIT_NOT_STARTED");
    }
    await tx
      .update(visits)
      .set({
        status: input.status,
        ...(input.status === "completed" ? { completedAt: now } : input.status === "cancelled" ? { cancelledAt: now } : {}),
        ...(input.visitNotes !== undefined ? { notes: input.visitNotes.trim() || null } : {}),
        revision: sql`${visits.revision} + 1`,
        updatedAt: now,
      })
      .where(and(eq(visits.orgId, orgId), eq(visits.id, before.visitId)));
    await saveRevision(tx, actor, before.visitId, input.status === "scheduled" ? "confirmed" : input.status, input.reason);
    return tz;
  });
  const visit = (await getVisit(actor, input.visitId)) as VisitView;
  // Recurring work books its next visit as one is done; a failure never fails marking it done.
  const nextVisit =
    input.status === "completed"
      ? await rollForward(orgId, visit.jobId, deps).catch((error: unknown) => {
          console.error("scheduling: the recurring work's next visit wasn't booked", { orgId, jobId: visit.jobId, error });
          return null;
        })
      : null;
  const [open] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(visits)
    .where(and(eq(visits.orgId, orgId), eq(visits.jobId, visit.jobId), inArray(visits.status, OPEN_VISIT)));
  const notified =
    input.status === "cancelled"
      ? await tellCrew(actor, visit.crew.map((c) => c.memberId), (lang) => crewText.cancelled(actor.name, visit, timeZone, lang), deps)
      : [];
  return { visit, openVisitsOnJob: open.n, notified, nextVisit };
}

/** Crew change only visits they're on; owners and admins any. Throws `NOT_ON_VISIT`. */
function requireOnVisit(actor: Pick<Actor, "memberId" | "role">, visit: Pick<VisitView, "crew">): void {
  if (!isPrivileged(actor.role) && !visit.crew.some((c) => c.memberId === actor.memberId)) throw new Error("NOT_ON_VISIT");
}

/** An open visit of today's, for the crew on site or running late. Throws when it isn't one. */
async function openVisitToday(actor: Actor, visitId: string, tx: Tx, now: Date): Promise<VisitView> {
  const before = await getVisit(actor, visitId, tx);
  if (!before) throw new Error("VISIT_NOT_FOUND");
  requireOnVisit(actor, before);
  if (!OPEN_VISIT.includes(before.status)) throw new Error(`VISIT_NOT_OPEN: it is ${before.status}`);
  const timeZone = (await getProfileWith(actor.orgId, tx)).timeZone;
  if (wallClock(before.startAt, timeZone).date !== wallClock(now, timeZone).date) throw new Error("VISIT_NOT_TODAY");
  return before;
}

/**
 * The crew are on site: marks today's visit started at `now`, which the day's route re-plans from
 * (`core/day-plan.ts`). A delay declared on the way is dropped, since they're there. Anyone on its crew, or an
 * owner or admin for any visit. Starting one already started changes nothing.
 */
export async function startVisit(actor: Actor, input: { visitId: string }, deps?: Deps): Promise<{ visit: VisitView; alreadyStarted: boolean }> {
  const { orgId } = actor;
  const now = deps?.now ?? new Date();
  const alreadyStarted = await db().transaction(async (tx) => {
    await lockSchedule(tx, orgId);
    const before = await openVisitToday(actor, input.visitId, tx, now);
    if (before.startedAt) return true;
    await tx
      .update(visits)
      .set({ startedAt: now, delayMinutes: 0, revision: sql`${visits.revision} + 1`, updatedAt: now })
      .where(and(eq(visits.orgId, orgId), eq(visits.id, before.visitId)));
    await saveRevision(tx, actor, before.visitId, "started", null);
    return false;
  });
  return { visit: (await getVisit(actor, input.visitId)) as VisitView, alreadyStarted };
}

/**
 * The crew say they're running late on today's visit: on the way (its arrival moves) or on site (its finish
 * does). `minutes` replaces any delay declared before; 0 clears it. Anyone on its crew, or an owner or admin.
 */
export async function setVisitDelay(actor: Actor, input: { visitId: string; minutes: number }, deps?: Deps): Promise<VisitView> {
  const { orgId } = actor;
  const now = deps?.now ?? new Date();
  const minutes = Math.round(input.minutes);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 480) throw new Error("INVALID_DELAY");
  await db().transaction(async (tx) => {
    await lockSchedule(tx, orgId);
    const before = await openVisitToday(actor, input.visitId, tx, now);
    await tx
      .update(visits)
      .set({ delayMinutes: minutes, revision: sql`${visits.revision} + 1`, updatedAt: now })
      .where(and(eq(visits.orgId, orgId), eq(visits.id, before.visitId)));
    await saveRevision(tx, actor, before.visitId, "delayed", `${minutes} min`);
  });
  return (await getVisit(actor, input.visitId)) as VisitView;
}

/**
 * Closes a job, owners and admins only: `completed` when the work is done (its visits that have started
 * are marked done), or `cancelled`. Visits still ahead are refused with `VISITS_AHEAD` unless
 * `cancelUpcomingVisits`, which cancels them and texts their crew. A completed job is what an invoice
 * will come from.
 */
export async function closeServiceJob(
  actor: Actor,
  input: { jobId: string; status: "completed" | "cancelled"; cancelUpcomingVisits?: boolean; reason?: string },
  deps?: Deps,
): Promise<{ job: ServiceJobView; completedVisits: number; cancelledVisits: VisitView[]; notified: string[] }> {
  requirePrivileged(actor);
  const { orgId } = actor;
  const now = deps?.now ?? new Date();
  const outcome = await db().transaction(async (tx) => {
    await lockSchedule(tx, orgId);
    const job = await jobRow(orgId, input.jobId, tx);
    if (!job) throw new Error("SERVICE_JOB_NOT_FOUND");
    if (job.status !== "open") throw new Error("JOB_CLOSED");
    const timeZone = (await getProfileWith(orgId, tx)).timeZone;
    const open = await loadVisitViews(orgId, [eq(visits.jobId, job.id), inArray(visits.status, OPEN_VISIT)], tx);
    const started = (v: VisitView) => v.startAt <= now;
    const ahead = input.status === "completed" ? open.filter((v) => !started(v)) : open;
    const upcoming = ahead.filter((v) => !started(v));
    if (upcoming.length && !input.cancelUpcomingVisits) {
      throw new Error(`VISITS_AHEAD: ${upcoming.map((v) => whenText(v.startAt, v.endAt, timeZone, "en")).join("; ")}`);
    }
    const toComplete = input.status === "completed" ? open.filter(started) : [];
    for (const v of toComplete) {
      await tx
        .update(visits)
        .set({ status: "completed", completedAt: now, revision: sql`${visits.revision} + 1`, updatedAt: now })
        .where(and(eq(visits.orgId, orgId), eq(visits.id, v.visitId)));
      await saveRevision(tx, actor, v.visitId, "completed", "The job was closed.");
    }
    for (const v of ahead) {
      await tx
        .update(visits)
        .set({ status: "cancelled", cancelledAt: now, revision: sql`${visits.revision} + 1`, updatedAt: now })
        .where(and(eq(visits.orgId, orgId), eq(visits.id, v.visitId)));
      await saveRevision(tx, actor, v.visitId, "cancelled", input.reason ?? "The job was closed.");
    }
    await tx
      .update(serviceJobs)
      .set({ status: input.status, closedAt: now, updatedAt: now })
      .where(and(eq(serviceJobs.orgId, orgId), eq(serviceJobs.id, job.id)));
    // `service_job.completed` is what invoicing will listen for.
    await recordEvent({ orgId, kind: `service_job.${input.status}`, refId: job.id, memberId: actor.memberId, data: { quoteId: job.quoteId } }, tx);
    return { timeZone, completed: toComplete.length, cancelled: ahead };
  });
  const notified: string[] = [];
  for (const v of outcome.cancelled.filter((v) => v.startAt > now)) {
    notified.push(...(await tellCrew(actor, v.crew.map((c) => c.memberId), (lang) => crewText.cancelled(actor.name, v, outcome.timeZone, lang), deps)));
  }
  return {
    job: (await getServiceJob(actor, input.jobId)) as ServiceJobView,
    completedVisits: outcome.completed,
    cancelledVisits: outcome.cancelled,
    notified: [...new Set(notified)],
  };
}

// ---------------------------------------------------------------------------------------------
// Recurring work

/**
 * Where recurring work's next visit lands among one day's slots and the days after (`findAvailability`'s): the
 * first day that has a slot that fits, at its usual clock when that's free, else the clock nearest it that day
 * (the earlier on a tie). Pure; null when no day has one.
 */
export function recurringSlot(slots: Slot[], date: string, time: string): Slot | null {
  const fitting = slots.filter((s) => s.fits && s.date >= date);
  const day = fitting.map((s) => s.date).sort()[0];
  if (!day) return null;
  const wanted = clockMinutes(time);
  const away = (slot: Slot) => Math.abs(clockMinutes(slot.start) - wanted);
  return fitting.filter((s) => s.date === day).sort((a, b) => away(a) - away(b) || a.startAt.getTime() - b.startAt.getTime())[0];
}

/** How many days past the date it falls on a recurring visit may land, when its crew can't take that day. */
const RECURRING_LATER_DAYS = 6;

/**
 * Books recurring work's next visit when it has none open: after its latest visit booked for real (done, or
 * cancelled to skip one; never one only pencilled in), on the recurrence's weekday and clock (`nextOccurrenceFrom`), for its length, with that visit's crew still
 * on the team. A day they can't take (time off, a full day) moves it to the first one after that can, through
 * `recurringSlot`. It goes through `bookVisit`, booked by the business's first owner or admin, with no crew text:
 * the morning route has it. Returns the visit, or null when there's nothing to book or nowhere to put it.
 */
export async function rollForward(orgId: string, jobId: string, deps?: Deps): Promise<VisitView | null> {
  const now = deps?.now ?? new Date();
  const job = await jobRow(orgId, jobId, db());
  if (!job || job.status !== "open" || !job.recurrence) return null;
  const booked = await loadVisitViews(orgId, [eq(visits.jobId, jobId)]);
  if (booked.some((v) => OPEN_VISIT.includes(v.status))) return null;
  // Only a visit booked for real sets when and with whom the next comes: one only ever pencilled in (a forwarded
  // email's) doesn't, done or cancelled.
  const held = booked.length
    ? await db()
        .selectDistinct({ visitId: visitRevisions.visitId })
        .from(visitRevisions)
        .where(
          and(
            eq(visitRevisions.orgId, orgId),
            inArray(visitRevisions.visitId, booked.map((v) => v.visitId)),
            sql`${visitRevisions.snapshot}->>'status' = 'scheduled'`,
          ),
        )
    : [];
  const last = booked.filter((v) => held.some((h) => h.visitId === v.visitId)).at(-1);
  if (!last) return null;
  const team = await scheduleCrew(orgId);
  const crew = last.crew.filter((c) => team.some((m) => m.memberId === c.memberId));
  const [booker] = await privilegedMembers(orgId);
  if (!crew.length || !booker) return null;
  const { timeZone } = await getProfileWith(orgId, db());
  const next = nextOccurrenceFrom(job.recurrence, last.startAt, timeZone, now);
  const durationMinutes = job.recurrence.durationMinutes ?? Math.round((last.endAt.getTime() - last.startAt.getTime()) / MINUTE);
  const viewer: Viewer = { orgId, memberId: null, role: "owner" };
  let slot: Slot | null = null;
  for (let d = 0; d <= RECURRING_LATER_DAYS && !slot; d++) {
    const found = await findAvailability(
      viewer,
      { memberIds: crew.map((c) => c.memberId), from: addDays(next.date, d), days: 1, durationMinutes, jobId, limit: 100, order: "time" },
      { now },
    );
    slot = recurringSlot(found.slots, next.date, next.time);
  }
  if (!slot) {
    console.info("scheduling: recurring work has no room for its next visit", { orgId, jobId, date: next.date });
    return null;
  }
  const actor: Actor = { orgId, memberId: booker.id, role: booker.role, name: booker.name, language: languageOf(booker) };
  try {
    const result = await bookVisit(
      actor,
      {
        jobId,
        memberIds: crew.map((c) => c.memberId),
        day: slot.date,
        time: slot.start,
        offsetMinutes: slot.offsetMinutes,
        durationMinutes,
        silent: true,
        nextOfRecurring: true,
      },
      deps,
    );
    return result.visit;
  } catch (error) {
    if (error instanceof Error && error.message === "NEXT_ALREADY_BOOKED") return null;
    throw error;
  }
}

/**
 * The hourly safety net: each of the business's open recurring jobs with no visit open gets its next one
 * (`rollForward`), so work skipped by a cancelled visit, or done without being marked through the schedule, still
 * comes round. One that fails is logged and the rest still run. Returns how many were booked.
 */
export async function rollForwardDue(orgId: string, deps?: Deps): Promise<number> {
  const due = await db()
    .select({ id: serviceJobs.id })
    .from(serviceJobs)
    .where(
      and(
        eq(serviceJobs.orgId, orgId),
        eq(serviceJobs.status, "open"),
        isNotNull(serviceJobs.recurrence),
        notExists(
          db()
            .select({ id: visits.id })
            .from(visits)
            .where(and(eq(visits.orgId, orgId), eq(visits.jobId, serviceJobs.id), inArray(visits.status, OPEN_VISIT))),
        ),
      ),
    );
  let count = 0;
  for (const { id } of due) {
    try {
      if (await rollForward(orgId, id, deps)) count++;
    } catch (error) {
      console.error("scheduling: the recurring work's next visit wasn't booked", { orgId, jobId: id, error });
    }
  }
  return count;
}

// ---------------------------------------------------------------------------------------------
// Time off

/**
 * Time off for a member, or with no member the whole business (owners and admins). Crew may add their
 * own. All day unless `start` and `end` (local `HH:MM`) are given; `endDay` makes it several days.
 * Refuses time that covers visits still booked for them (`HAS_VISITS`): move those first.
 */
export async function addTimeOff(
  actor: Actor,
  input: { memberId?: string | null; day: string; endDay?: string; start?: string; end?: string; reason?: string },
  deps?: Deps,
): Promise<BusyBlock & { memberName: string | null }> {
  const { orgId } = actor;
  const now = deps?.now ?? new Date();
  const memberId = input.memberId ?? null;
  if (!isPrivileged(actor.role) && memberId !== actor.memberId) throw new Error("NOT_PRIVILEGED");
  return db().transaction(async (tx) => {
    await lockSchedule(tx, orgId);
    const timeZone = (await getProfileWith(orgId, tx)).timeZone;
    let memberName: string | null = null;
    if (memberId) memberName = (await crewFor(orgId, [memberId], tx))[0].name;
    const first = resolveDay(input.day, timeZone, now);
    const last = input.endDay ? resolveDay(input.endDay, timeZone, now) : first;
    if (last < first) throw new Error("INVALID_DATE: the last day is before the first");
    if ((input.start === undefined) !== (input.end === undefined)) throw new Error("INVALID_TIME: give both a start and an end, or neither for all day");
    const startAt = input.start ? resolveLocalTime(first, input.start, timeZone) : dayStart(first, timeZone);
    const endAt = input.end ? resolveLocalTime(last, input.end, timeZone) : dayStart(addDays(last, 1), timeZone);
    if (endAt <= startAt) throw new Error("INVALID_TIME: it must end after it starts");
    if (endAt.getTime() - startAt.getTime() > 62 * DAY) throw new Error("INVALID_TIME: at most 62 days at a time");
    const clashes = await loadVisitViews(
      orgId,
      [
        inArray(visits.status, OPEN_VISIT),
        ...(memberId ? [onVisit(orgId, memberId)] : []),
        lt(sql`${visits.startAt} - ${visits.bufferBeforeMinutes} * interval '1 minute'`, endAt.toISOString()),
        gt(sql`${visits.endAt} + ${visits.bufferAfterMinutes} * interval '1 minute'`, startAt.toISOString()),
      ],
      tx,
    );
    if (clashes.length) {
      throw new Error(`HAS_VISITS: ${clashes.map((v) => `${v.title} ${whenText(v.startAt, v.endAt, timeZone, "en")}`).join("; ")}`);
    }
    const [block] = await tx
      .insert(busyBlocks)
      .values({ id: newId("off"), orgId, memberId, startAt, endAt, reason: input.reason?.trim() || null, createdByMemberId: actor.memberId })
      .returning();
    await recordEvent({ orgId, kind: "schedule.time_off", refId: block.id, memberId: actor.memberId }, tx);
    return { ...block, memberName };
  });
}

/** Takes time off back off the schedule. Crew may remove only their own. */
export async function removeTimeOff(actor: Actor, blockId: string): Promise<BusyBlock> {
  const { orgId } = actor;
  const [block] = await db()
    .select()
    .from(busyBlocks)
    .where(and(eq(busyBlocks.orgId, orgId), eq(busyBlocks.id, blockId), isNull(busyBlocks.cancelledAt)));
  if (!block) throw new Error("TIME_OFF_NOT_FOUND");
  if (!isPrivileged(actor.role) && block.memberId !== actor.memberId) throw new Error("TIME_OFF_NOT_FOUND");
  const [row] = await db()
    .update(busyBlocks)
    .set({ cancelledAt: new Date() })
    .where(and(eq(busyBlocks.orgId, orgId), eq(busyBlocks.id, blockId)))
    .returning();
  await recordEvent({ orgId, kind: "schedule.time_off_removed", refId: blockId, memberId: actor.memberId });
  return row;
}

// ---------------------------------------------------------------------------------------------
// Words

/** One line for a visit: "Tue, Oct 20, 9 AM–10 AM · 12 Oak St · Carlos, Ana". */
export function visitLine(visit: VisitView, timeZone: string, language: Language, options: { crew?: boolean } = {}): string {
  const parts = [whenText(visit.startAt, visit.endAt, timeZone, language), visit.title];
  if (visit.address && visit.address !== visit.title) parts.push(visit.address);
  if (options.crew !== false && visit.crew.length) parts.push(visit.crew.map((c) => c.name).join(", "));
  const status = visit.status === "scheduled" ? "" : ` (${STATUS_WORD[language][visit.status]})`;
  return `${parts.join(" · ")}${status}`;
}

const STATUS_WORD: Record<Language, Record<VisitStatus, string>> = {
  en: { proposed: "pencilled in", scheduled: "booked", completed: "done", cancelled: "cancelled" },
  es: { proposed: "tentativa", scheduled: "agendada", completed: "hecha", cancelled: "cancelada" },
};

/** "About 25 min from the yard.", when the drive in is known; empty otherwise. */
function driveText(v: VisitView, lang: Language): string {
  const leg = v.drive?.fromPrevious;
  if (!leg || leg.minutes === 0) return "";
  const from = leg.yard ? (lang === "es" ? "la base" : "the yard") : leg.label;
  return lang === "es" ? ` Unos ${leg.minutes} min desde ${from}.` : ` About ${leg.minutes} min from ${from}.`;
}

const crewText = {
  booked: (by: string, v: VisitView, tz: string, lang: Language) =>
    lang === "es"
      ? `${by} te agendó para ${v.title}: ${whenText(v.startAt, v.endAt, tz, lang)}.${driveText(v, lang)}`
      : `${by} booked you for ${v.title}: ${whenText(v.startAt, v.endAt, tz, lang)}.${driveText(v, lang)}`,
  moved: (by: string, v: VisitView, tz: string, lang: Language) =>
    lang === "es"
      ? `${by} movió ${v.title} a ${whenText(v.startAt, v.endAt, tz, lang)}.`
      : `${by} moved ${v.title} to ${whenText(v.startAt, v.endAt, tz, lang)}.`,
  removed: (by: string, v: VisitView, tz: string, lang: Language) =>
    lang === "es"
      ? `${by} te quitó de ${v.title} (${dayText(wallClock(v.startAt, tz).date, lang)}, ${timeText(v.startAt, tz, lang)}).`
      : `${by} took you off ${v.title} (${dayText(wallClock(v.startAt, tz).date, lang)}, ${timeText(v.startAt, tz, lang)}).`,
  cancelled: (by: string, v: VisitView, tz: string, lang: Language) =>
    lang === "es"
      ? `${by} canceló ${v.title} del ${dayText(wallClock(v.startAt, tz).date, lang)}, ${timeText(v.startAt, tz, lang)}.`
      : `${by} cancelled ${v.title} on ${dayText(wallClock(v.startAt, tz).date, lang)}, ${timeText(v.startAt, tz, lang)}.`,
};

/** The work's checklist for crew booked on a visit, made first if need be; null without one, or when it can't be read. */
async function crewBrief(orgId: string, visitId: string): Promise<CrewChecklist | null> {
  const [row] = await db().select({ jobId: visits.jobId }).from(visits).where(and(eq(visits.orgId, orgId), eq(visits.id, visitId)));
  if (!row) return null;
  try {
    return await crewChecklist(orgId, row.jobId);
  } catch (error) {
    console.error("scheduling: the visit's checklist was left off the crew text", error);
    return null;
  }
}

/** The booking line, then the work's checklist under it. */
const withChecklist = (line: string, brief: CrewChecklist | null, lang: Language) => (brief ? `${line}\n\n${brief.lines(lang)}` : line);

/** The posting the quotes service uses; resolved lazily so the module graph has no cycle. */
const defaultPost: Poster = async (orgId, memberId, payload, kind) => {
  const { postToMember } = await import("./outbound");
  return postToMember(orgId, memberId, payload, kind);
};

/**
 * Texts crew members about a change to their schedule, each in their language, never the one who made
 * it. `brief` adds the work's priced photo, in their language. Held back by quiet hours, the text is queued for
 * when they end, without the file. A failed text never fails the change. Returns the names of who got it
 * now or will then.
 */
async function tellCrew(
  actor: Actor,
  memberIds: string[],
  text: (language: Language) => string,
  deps?: Deps,
  brief?: CrewChecklist | null,
): Promise<string[]> {
  const out: string[] = [];
  const ids = [...new Set(memberIds)].filter((id) => id !== actor.memberId);
  if (ids.length === 0) return out;
  const rows = await db()
    .select()
    .from(members)
    .where(and(eq(members.orgId, actor.orgId), inArray(members.id, ids), eq(members.status, "active")));
  for (const member of rows) {
    const body = text(languageOf(member));
    try {
      const photo = brief ? await brief.photo(languageOf(member)) : null;
      const result = await (deps?.post ?? defaultPost)(actor.orgId, member.id, { text: body, ...(photo ?? {}) }, "proactive");
      if (result.posted) {
        out.push(member.name);
      } else if (result.reason === "quiet_hours") {
        const { queueNotice } = await import("./followups");
        await queueNotice({ orgId: actor.orgId, memberId: member.id, quoteId: null, payload: { text: body, asksApproval: false }, now: deps?.now ?? new Date() });
        out.push(member.name);
      }
    } catch (error) {
      console.error("scheduling: crew text failed", error);
    }
  }
  return out;
}

/** A visit as tools return it: local day and times, crew names, and a line ready to send. */
export function visitForTool(visit: VisitView, timeZone: string, language: Language) {
  const start = wallClock(visit.startAt, timeZone);
  return {
    visitId: visit.visitId,
    jobId: visit.jobId,
    quoteId: visit.quoteId,
    title: visit.title,
    customerName: visit.customerName,
    address: visit.address,
    crew: visit.crew,
    date: start.date,
    start: start.time,
    end: wallClock(visit.endAt, timeZone).time,
    status: visit.status,
    notes: visit.notes,
    ...(visit.checklist ? { checklist: visit.checklist } : {}),
    ...(visit.recurrence ? { recurring: recurrenceText(visit.recurrence, language, start.date) } : {}),
    ...(visit.drive?.fromPrevious
      ? { driveFromPreviousMinutes: visit.drive.fromPrevious.minutes, driveFrom: visit.drive.fromPrevious.yard ? "the yard" : visit.drive.fromPrevious.label }
      : {}),
    ...(visit.drive?.toNext ? { driveToNextMinutes: visit.drive.toNext.minutes, driveTo: visit.drive.toNext.yard ? "the yard" : visit.drive.toNext.label } : {}),
    line: visitLine(visit, timeZone, language),
  };
}

const CONFIRM: Record<Language, { booked: string; proposed: string; moved: string; with: string }> = {
  en: { booked: "Booked", proposed: "Pencilled in", moved: "Moved", with: "with" },
  es: { booked: "Agendado", proposed: "Apartado", moved: "Movido", with: "con" },
};

/** The one-line confirmation: "Booked: 12 Oak St, Tue, Oct 20, 9 AM–10 AM, with Carlos and Ana." */
export function confirmText(kind: "booked" | "moved", visit: VisitView, timeZone: string, language: Language): string {
  const copy = CONFIRM[language];
  const verb = kind === "moved" ? copy.moved : visit.status === "proposed" ? copy.proposed : copy.booked;
  const crew = crewNames(visit.crew, language);
  return `${verb}: ${visit.title}, ${whenText(visit.startAt, visit.endAt, timeZone, language)}${crew ? `, ${copy.with} ${crew}` : ""}.`;
}

/** "Fri, Oct 23 (all day)", "Fri, Oct 23–Sun, Oct 25 (all day)", or "Fri, Oct 23, 1 PM–5 PM". */
export function timeOffText(block: Pick<BusyBlock, "startAt" | "endAt">, timeZone: string, language: Language): string {
  const start = wallClock(block.startAt, timeZone);
  const end = wallClock(block.endAt, timeZone);
  if (start.time === "00:00" && end.time === "00:00") {
    const last = addDays(end.date, -1);
    const days = last === start.date ? dayText(start.date, language) : `${dayText(start.date, language)}–${dayText(last, language)}`;
    return `${days} (${language === "es" ? "todo el día" : "all day"})`;
  }
  return whenText(block.startAt, block.endAt, timeZone, language);
}

/** True when the member is on a visit (not cancelled) of work for this quote or customer: crew may then open it. */
export async function isOnWorkFor(orgId: string, memberId: string, about: { quoteId: string } | { customerId: string }): Promise<boolean> {
  const [row] = await db()
    .select({ id: visits.id })
    .from(visits)
    .innerJoin(serviceJobs, and(eq(serviceJobs.orgId, orgId), eq(serviceJobs.id, visits.jobId)))
    .innerJoin(visitCrew, and(eq(visitCrew.orgId, orgId), eq(visitCrew.visitId, visits.id), eq(visitCrew.memberId, memberId)))
    .where(
      and(
        eq(visits.orgId, orgId),
        ne(visits.status, "cancelled"),
        "quoteId" in about ? eq(serviceJobs.quoteId, about.quoteId) : eq(serviceJobs.customerId, about.customerId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

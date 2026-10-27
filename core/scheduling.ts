// The schedule: service jobs (the work a won quote becomes, or work on its own), their visits, who goes,
// working hours, and time off. The
// people booked are our members, the business's time zone is its profile's, and every query is scoped
// by the caller's org. The tools and the web pages both call these.
//
// Who may do what: owners and admins book, move, and cancel visits, open and close jobs, set hours, and
// add anyone's time off. Everyone reads the whole schedule and marks visits done; crew add or remove
// their own time off. Booking someone sends them a heads-up text (never a customer: they don't text us).
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, notExists, or, sql, type SQL } from "drizzle-orm";
import {
  busyBlocks,
  businessProfile,
  customers,
  members,
  properties,
  quotes,
  serviceJobs,
  visitCrew,
  visitRevisions,
  visits,
} from "../schema/schema";
import { db, newId, type Db, type Tx } from "./db";
import { recordEvent } from "./events";
import { isLanguage, type Language } from "./language";
import { isPrivileged, type Caller, type Member } from "./members";
import { getProfileWith } from "./profile";
import type { Poster } from "./quotes";
import {
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
  quoteId: string | null;
  crew: CrewRef[];
  startAt: Date;
  endAt: Date;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  status: VisitStatus;
  notes: string | null;
  revision: number;
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
async function lockSchedule(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`schedule:${orgId}`}))`);
}

const languageOf = (member: Pick<Member, "language">): Language => (isLanguage(member.language) ? member.language : "en");

// ---------------------------------------------------------------------------------------------
// Crew and hours

export type CrewMember = { memberId: string; name: string; role: Member["role"]; hours: WorkingInterval[]; ownHours: boolean };

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
    .select({ visit: visits, job: serviceJobs, customerName: customers.name, address: properties.address })
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

/** Visits matching `where`, earliest first, with their job, customer, address, and crew. */
async function loadVisitViews(orgId: string, where: SQL[], executor: Db | Tx = db(), limit = 500): Promise<VisitView[]> {
  const rows = await visitQuery(executor, orgId)
    .where(and(eq(visits.orgId, orgId), ...where))
    .orderBy(asc(visits.startAt), asc(visits.id))
    .limit(limit);
  const crew = await crewOf(orgId, rows.map((r) => r.visit.id), executor);
  return rows.map(({ visit, job, customerName, address }) => ({
    visitId: visit.id,
    jobId: job.id,
    title: job.title,
    jobStatus: job.status,
    customerId: job.customerId,
    customerName,
    address,
    quoteId: job.quoteId,
    crew: crew.get(visit.id) ?? [],
    startAt: visit.startAt,
    endAt: visit.endAt,
    bufferBeforeMinutes: visit.bufferBeforeMinutes,
    bufferAfterMinutes: visit.bufferAfterMinutes,
    status: visit.status,
    notes: visit.notes,
    revision: visit.revision,
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
    visits: await loadVisitViews(orgId, where),
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
// Availability

export type Slot = { date: string; start: string; end: string; startAt: Date; endAt: Date; offsetMinutes: number };

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
 * Times the crew are all free for `durationMinutes` (plus buffers), from `from` for `days` days, in
 * 15-minute steps inside each one's working hours, around their visits and time off. Advisory: it
 * holds nothing, and booking checks again. Crew may only look up themselves.
 */
export async function findAvailability(
  actor: Viewer,
  input: {
    memberIds: string[];
    from: string;
    days?: number;
    durationMinutes?: number;
    bufferBeforeMinutes?: number;
    bufferAfterMinutes?: number;
    reschedulingVisitId?: string;
    limit?: number;
  },
  deps?: { now?: Date },
): Promise<{ timeZone: string; durationMinutes: number; slots: Slot[]; advisory: true }> {
  const { orgId } = actor;
  const now = deps?.now ?? new Date();
  const profile = await getProfileWith(orgId, db());
  const timeZone = profile.timeZone;
  const crew = await crewFor(orgId, input.memberIds, db());
  const duration = clampDuration(input.durationMinutes);
  const before = clampBuffer(input.bufferBeforeMinutes);
  const after = clampBuffer(input.bufferAfterMinutes);
  const days = Math.min(Math.max(Math.trunc(input.days ?? 7), 1), 14);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 60), 1), 100);
  const from = resolveDay(input.from, timeZone, now);
  if (input.reschedulingVisitId) {
    const moving = await getVisit(actor, input.reschedulingVisitId);
    if (!moving) throw new Error("VISIT_NOT_FOUND");
    if (!OPEN_VISIT.includes(moving.status)) throw new Error("VISIT_NOT_OPEN");
  }
  const window = { startAt: new Date(dayStart(from, timeZone).getTime() - DAY), endAt: new Date(dayStart(addDays(from, days), timeZone).getTime() + DAY) };
  const busy = new Map<string, Interval[]>();
  for (const member of crew) {
    const taken = await occupancy(orgId, member.memberId, window, db(), input.reschedulingVisitId);
    busy.set(member.memberId, [...taken.visits.map(occupiedInterval), ...taken.blocks]);
  }
  const slots: Slot[] = [];
  for (let d = 0; d < days && slots.length < limit; d++) {
    const date = addDays(from, d);
    const starts = new Set<number>();
    for (const member of crew) for (const s of workingSegments(date, member.hours)) for (let m = s.start; m < s.end; m += 15) starts.add(m);
    for (const minute of [...starts].sort((a, b) => a - b)) {
      if (slots.length >= limit) break;
      for (const startAt of localTimeInstants(date, minutesClock(minute), timeZone)) {
        if (startAt <= now) continue;
        const endAt = new Date(startAt.getTime() + duration * MINUTE);
        const held = occupiedInterval({ startAt, endAt, bufferBeforeMinutes: before, bufferAfterMinutes: after });
        const free = crew.every(
          (member) =>
            withinWorkingHours(held.startAt, held.endAt, timeZone, member.hours) &&
            !(busy.get(member.memberId) ?? []).some((taken) => intervalsOverlap(held, taken)),
        );
        if (!free) continue;
        slots.push({
          date,
          start: wallClock(startAt, timeZone).time,
          end: wallClock(endAt, timeZone).time,
          startAt,
          endAt,
          offsetMinutes: offsetMinutesAt(startAt, timeZone),
        });
      }
    }
  }
  return { timeZone, durationMinutes: duration, slots, advisory: true };
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

type JobInput = { quoteId?: string; customerId?: string; propertyId?: string; title?: string; notes?: string };

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
      createdByMemberId: actor.memberId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await recordEvent({ orgId, kind: "service_job.created", refId: job.id, memberId: actor.memberId }, tx);
  return { job, created: true };
}

/** Opens a job without booking it yet: from a quote (`quoteId`) or on its own (`title`). Owners and admins. */
export async function createServiceJob(actor: Actor, input: JobInput, deps?: Deps): Promise<{ job: ServiceJobView; created: boolean }> {
  requirePrivileged(actor);
  const now = deps?.now ?? new Date();
  const { job, created } = await db().transaction(async (tx) => {
    await lockSchedule(tx, actor.orgId);
    return ensureJob(actor, input, tx, now);
  });
  return { job: (await getServiceJob(actor, job.id)) as ServiceJobView, created };
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
  | { kind: "job"; jobId: string; quoteId: string | null; title: string; customerName: string | null; address: string | null; since: Date };

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
};

export type BookingResult = { visit: VisitView; jobCreated: boolean; timeZone: string; notified: string[] };

/**
 * Books a visit, owners and admins only. Refuses a past time, a time outside the crew's hours (unless
 * `allowOutsideHours`), and one over their other visits or time off. Texts each crew member booked,
 * other than whoever booked it.
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
    const bufferBeforeMinutes = clampBuffer(input.bufferBeforeMinutes);
    const bufferAfterMinutes = clampBuffer(input.bufferAfterMinutes);
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
    await tx.update(serviceJobs).set({ updatedAt: now }).where(and(eq(serviceJobs.orgId, orgId), eq(serviceJobs.id, job.id)));
    await saveRevision(tx, actor, id, "booked", null);
    return { id, jobCreated, timeZone };
  });
  const visit = (await getVisit(actor, result.id)) as VisitView;
  const notified = input.silent ? [] : await tellCrew(actor, visit.crew.map((c) => c.memberId), (lang) => crewText.booked(actor.name, visit, result.timeZone, lang), deps);
  return { visit, jobCreated: result.jobCreated, timeZone: result.timeZone, notified };
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
};

/**
 * Moves a visit, changes how long it is, or changes who goes, owners and admins only. Whatever isn't
 * given stays as it was. The same checks as booking apply, leaving the visit's own time out. Texts
 * whoever is on it before or after, other than whoever moved it.
 */
export async function rescheduleVisit(actor: Actor, input: RescheduleInput, deps?: Deps): Promise<BookingResult & { previous: VisitView }> {
  requirePrivileged(actor);
  const { orgId } = actor;
  const now = deps?.now ?? new Date();
  const previous = await getVisit(actor, input.visitId);
  if (!previous) throw new Error("VISIT_NOT_FOUND");
  const result = await db().transaction(async (tx) => {
    await lockSchedule(tx, orgId);
    const before = await getVisit(actor, input.visitId, tx);
    if (!before) throw new Error("VISIT_NOT_FOUND");
    if (!OPEN_VISIT.includes(before.status)) throw new Error(`VISIT_NOT_OPEN: it is ${before.status}`);
    if (before.jobStatus !== "open") throw new Error("JOB_CLOSED");
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
    return { timeZone };
  });
  const visit = (await getVisit(actor, input.visitId)) as VisitView;
  const now_ = visit.crew.map((c) => c.memberId);
  const moved = previous.startAt.getTime() !== visit.startAt.getTime() || previous.endAt.getTime() !== visit.endAt.getTime();
  const notified = [
    ...(await tellCrew(
      actor,
      now_.filter((id) => moved || !previous.crew.some((c) => c.memberId === id)),
      (lang) => (previous.crew.some((c) => now_.includes(c.memberId)) && moved ? crewText.moved(actor.name, visit, result.timeZone, lang) : crewText.booked(actor.name, visit, result.timeZone, lang)),
      deps,
    )),
    ...(await tellCrew(
      actor,
      previous.crew.map((c) => c.memberId).filter((id) => !now_.includes(id)),
      (lang) => crewText.removed(actor.name, previous, result.timeZone, lang),
      deps,
    )),
  ];
  return { visit, previous, jobCreated: false, timeZone: result.timeZone, notified };
}

/**
 * Marks a visit done, cancels it, or confirms one pencilled in. Anyone on the team marks a visit done
 * once its day has come (someone may finish another crew's job); everything else is for owners and admins. A cancelled visit's crew
 * get a text. Returns how many visits the job still has open, so the member can be asked about closing it.
 */
export async function changeVisitStatus(
  actor: Actor,
  input: { visitId: string; status: "completed" | "cancelled" | "scheduled"; reason?: string; visitNotes?: string },
  deps?: Deps,
): Promise<{ visit: VisitView; openVisitsOnJob: number; notified: string[] }> {
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
  const [open] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(visits)
    .where(and(eq(visits.orgId, orgId), eq(visits.jobId, visit.jobId), inArray(visits.status, OPEN_VISIT)));
  const notified =
    input.status === "cancelled"
      ? await tellCrew(actor, visit.crew.map((c) => c.memberId), (lang) => crewText.cancelled(actor.name, visit, timeZone, lang), deps)
      : [];
  return { visit, openVisitsOnJob: open.n, notified };
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

const crewText = {
  booked: (by: string, v: VisitView, tz: string, lang: Language) =>
    lang === "es"
      ? `${by} te agendó para ${v.title}: ${whenText(v.startAt, v.endAt, tz, lang)}.`
      : `${by} booked you for ${v.title}: ${whenText(v.startAt, v.endAt, tz, lang)}.`,
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

/** The posting the quotes service uses; resolved lazily so the module graph has no cycle. */
const defaultPost: Poster = async (orgId, memberId, payload, kind) => {
  const { postToMember } = await import("./outbound");
  return postToMember(orgId, memberId, payload, kind);
};

/**
 * Texts crew members about a change to their schedule, each in their language, never the one who made
 * it. Held back by quiet hours, it's queued for when they end. A failed text never fails the change.
 * Returns the names of who got it now or will then.
 */
async function tellCrew(actor: Actor, memberIds: string[], text: (language: Language) => string, deps?: Deps): Promise<string[]> {
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
      const result = await (deps?.post ?? defaultPost)(actor.orgId, member.id, { text: body }, "proactive");
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
  const names = visit.crew.map((c) => c.name.split(/\s+/)[0]);
  const and = language === "es" ? " y " : " and ";
  const crew = names.length > 1 ? `${names.slice(0, -1).join(", ")}${and}${names.at(-1)}` : (names[0] ?? "");
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

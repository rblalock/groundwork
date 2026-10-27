import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { members, messages, quoteAttachments, serviceJobs, visits, workPhotos } from "../schema/schema";
import { db, newId } from "./db";
import { isPrivileged, type Caller } from "./members";
import { getProfile } from "./profile";
import { readSchedule } from "./scheduling";
import { wallClock } from "./scheduling-time";

// Photos of the work itself, often the finished job: on the work (a service job) and, when known, the
// visit they were taken on. Members text them in (the assistant's `attach_work_photos`) or upload them on
// the work's page. Anyone on the team adds them, for any work: someone may stop by and finish another
// crew's job. Whoever added a photo, or an owner or admin, takes it off.

export type WorkPhotoView = {
  id: string;
  jobId: string;
  jobTitle: string;
  visitId: string | null;
  url: string;
  name: string | null;
  mimeType: string | null;
  description: string | null;
  addedByMemberId: string;
  addedByName: string;
  createdAt: Date;
};

/** At most this many photos stay on one piece of work. */
export const WORK_PHOTO_LIMIT = 60;

export type WorkTarget = { jobId: string; visitId: string | null };

const addedBy = alias(members, "work_photo_added_by");

/**
 * The photos on a piece of work, oldest first (the order they were sent in), or on all of a customer's
 * work, newest first. Photos taken off are left out.
 */
export async function listWorkPhotos(orgId: string, about: { jobId: string } | { customerId: string }, limit = WORK_PHOTO_LIMIT): Promise<WorkPhotoView[]> {
  const rows = await db()
    .select({ photo: workPhotos, jobTitle: serviceJobs.title, addedByName: addedBy.name })
    .from(workPhotos)
    .innerJoin(serviceJobs, and(eq(serviceJobs.orgId, orgId), eq(serviceJobs.id, workPhotos.jobId)))
    .innerJoin(addedBy, eq(addedBy.id, workPhotos.addedByMemberId))
    .where(
      and(
        eq(workPhotos.orgId, orgId),
        isNull(workPhotos.removedAt),
        "jobId" in about ? eq(workPhotos.jobId, about.jobId) : eq(serviceJobs.customerId, about.customerId),
      ),
    )
    .orderBy(...("jobId" in about ? [asc(workPhotos.createdAt), asc(workPhotos.id)] : [desc(workPhotos.createdAt), desc(workPhotos.id)]))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map(({ photo, jobTitle, addedByName }) => ({
    id: photo.id,
    jobId: photo.jobId,
    jobTitle,
    visitId: photo.visitId,
    url: photo.url,
    name: photo.name,
    mimeType: photo.mimeType,
    description: photo.description,
    addedByMemberId: photo.addedByMemberId,
    addedByName,
    createdAt: photo.createdAt,
  }));
}

/** The work and visit, checked to be this business's (and the visit on that work). Throws `SERVICE_JOB_NOT_FOUND` or `VISIT_NOT_FOUND`. */
async function checkTarget(orgId: string, target: { jobId?: string; visitId?: string | null }): Promise<WorkTarget> {
  if (target.visitId) {
    const [visit] = await db()
      .select({ jobId: visits.jobId })
      .from(visits)
      .where(and(eq(visits.orgId, orgId), eq(visits.id, target.visitId)));
    if (!visit || (target.jobId && visit.jobId !== target.jobId)) throw new Error("VISIT_NOT_FOUND");
    return { jobId: visit.jobId, visitId: target.visitId };
  }
  if (!target.jobId) throw new Error("SERVICE_JOB_NOT_FOUND");
  const [job] = await db()
    .select({ id: serviceJobs.id })
    .from(serviceJobs)
    .where(and(eq(serviceJobs.orgId, orgId), eq(serviceJobs.id, target.jobId)));
  if (!job) throw new Error("SERVICE_JOB_NOT_FOUND");
  return { jobId: job.id, visitId: null };
}

async function photoCount(orgId: string, jobId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(workPhotos)
    .where(and(eq(workPhotos.orgId, orgId), eq(workPhotos.jobId, jobId), isNull(workPhotos.removedAt)));
  return row?.n ?? 0;
}

/**
 * Which work photos texted now are for: the visit given (or its work), the work given, or else the visit
 * the member is on today, when there's one (or one under way now). Otherwise the visits they could mean,
 * for the assistant to ask about, or none.
 */
export async function resolveWorkTarget(
  actor: Caller,
  input: { jobId?: string; visitId?: string },
  now: Date = new Date(),
): Promise<{ target: WorkTarget } | { choose: Array<{ visitId: string; jobId: string; title: string; customerName: string | null }> }> {
  if (input.visitId || input.jobId) return { target: await checkTarget(actor.orgId, input) };
  const { timeZone } = await getProfile(actor.orgId);
  const today = wallClock(now, timeZone).date;
  const { visits: mine } = await readSchedule(actor, { from: today, days: 1, memberId: actor.memberId }, { now });
  const underWay = mine.filter((v) => v.startAt <= now && now <= v.endAt);
  const pick = mine.length === 1 ? mine[0] : underWay.length === 1 ? underWay[0] : null;
  if (pick) return { target: { jobId: pick.jobId, visitId: pick.visitId } };
  return { choose: mine.map((v) => ({ visitId: v.visitId, jobId: v.jobId, title: v.title, customerName: v.customerName })) };
}

/**
 * Attaches the photos this member texted since `since` that no quote or work has taken yet (documents
 * set aside are left alone) to the work. Returns how many it added. Throws `SERVICE_JOB_NOT_FOUND`,
 * `VISIT_NOT_FOUND`, or `TOO_MANY_PHOTOS`.
 */
export async function attachTextedWorkPhotos(actor: Caller, target: { jobId?: string; visitId?: string | null }, since: Date, description?: string): Promise<number> {
  const { orgId } = actor;
  const checked = await checkTarget(orgId, target);
  const inbound = await db()
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        eq(messages.memberId, actor.memberId),
        eq(messages.direction, "inbound"),
        gte(messages.createdAt, since),
        sql`jsonb_array_length(${messages.attachments}) > 0`,
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id));
  if (inbound.length === 0) return 0;
  const ids = inbound.map((m) => m.id);
  const [onQuotes, onWork] = await Promise.all([
    db().select({ messageId: quoteAttachments.messageId, url: quoteAttachments.url }).from(quoteAttachments).where(and(eq(quoteAttachments.orgId, orgId), inArray(quoteAttachments.messageId, ids))),
    db().select({ messageId: workPhotos.messageId, url: workPhotos.url }).from(workPhotos).where(and(eq(workPhotos.orgId, orgId), inArray(workPhotos.messageId, ids))),
  ]);
  const taken = new Set([...onQuotes, ...onWork].map((t) => `${t.messageId}\n${t.url}`));
  const rows = inbound.flatMap((message) =>
    message.attachments
      .filter((a) => a.type === "image" && !a.document && !taken.has(`${message.id}\n${a.url}`))
      .map((a) => ({
        id: newId("wph"),
        orgId,
        jobId: checked.jobId,
        visitId: checked.visitId,
        messageId: message.id,
        addedByMemberId: actor.memberId,
        url: a.url,
        name: a.name ?? null,
        mimeType: a.mimeType ?? null,
        description: description?.trim().slice(0, 500) || null,
        // When it was sent, so photos keep the order the member sent them in.
        createdAt: message.createdAt,
      })),
  );
  if (rows.length === 0) return 0;
  if ((await photoCount(orgId, checked.jobId)) + rows.length > WORK_PHOTO_LIMIT) throw new Error("TOO_MANY_PHOTOS");
  const added = await db().insert(workPhotos).values(rows).onConflictDoNothing().returning({ id: workPhotos.id });
  return added.length;
}

/** Adds a photo uploaded on the work's page (already checked and stored). Throws as `attachTextedWorkPhotos`. */
export async function addUploadedWorkPhoto(
  actor: Caller,
  target: { jobId: string; visitId?: string | null },
  photo: { url: string; name: string; mimeType: string },
): Promise<WorkPhotoView> {
  const checked = await checkTarget(actor.orgId, target);
  if ((await photoCount(actor.orgId, checked.jobId)) >= WORK_PHOTO_LIMIT) throw new Error("TOO_MANY_PHOTOS");
  const id = newId("wph");
  await db().insert(workPhotos).values({ id, orgId: actor.orgId, ...checked, addedByMemberId: actor.memberId, ...photo });
  const [view] = (await listWorkPhotos(actor.orgId, { jobId: checked.jobId })).filter((p) => p.id === id);
  return view;
}

/** Takes a photo off its work: whoever added it, or an owner or admin. Throws `PHOTO_NOT_FOUND` or `NOT_PRIVILEGED`. */
export async function removeWorkPhoto(actor: Caller, jobId: string, photoId: string, now: Date = new Date()): Promise<void> {
  const [photo] = await db()
    .select({ addedBy: workPhotos.addedByMemberId })
    .from(workPhotos)
    .where(and(eq(workPhotos.orgId, actor.orgId), eq(workPhotos.jobId, jobId), eq(workPhotos.id, photoId), isNull(workPhotos.removedAt)));
  if (!photo) throw new Error("PHOTO_NOT_FOUND");
  if (photo.addedBy !== actor.memberId && !isPrivileged(actor.role)) throw new Error("NOT_PRIVILEGED");
  await db()
    .update(workPhotos)
    .set({ removedAt: now })
    .where(and(eq(workPhotos.orgId, actor.orgId), eq(workPhotos.id, photoId)));
}

/** One photo on the work, still on it, for serving its bytes. */
export async function workPhoto(orgId: string, jobId: string, photoId: string): Promise<{ url: string; name: string | null } | null> {
  const [photo] = await db()
    .select({ url: workPhotos.url, name: workPhotos.name })
    .from(workPhotos)
    .where(and(eq(workPhotos.orgId, orgId), eq(workPhotos.jobId, jobId), eq(workPhotos.id, photoId), isNull(workPhotos.removedAt)));
  return photo ?? null;
}

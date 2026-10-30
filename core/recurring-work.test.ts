import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { serviceJobs } from "../schema/schema";
import { saveCustomer } from "./customers";
import { db } from "./db";
import { addPhone, createMember, recordInbound, type Caller } from "./members";
import { updateProfile } from "./profile";
import type { Poster } from "./quotes";
import { bookVisit, createServiceJob, getServiceJob, jobRecurrenceText, setRecurrence, visitForTool } from "./scheduling";
import { TEST_ORG, withTestDb } from "./test-db";

const TZ = "America/New_York";
const local = (date: string, clock: string) => new Date(`${date}T${clock}:00-05:00`);
const NOW = local("2026-11-05", "07:00"); // a Thursday

async function person(name: string, role: Caller["role"], phone: string, language: "en" | "es" = "en"): Promise<Caller> {
  const member = await createMember({ orgId: TEST_ORG, name, role, language });
  const row = await addPhone(TEST_ORG, member.id, phone);
  await recordInbound(TEST_ORG, row.id, `thread:${phone}`, new Date(), "iMessage");
  return { orgId: TEST_ORG, memberId: member.id, name, role, language, phoneE164: phone };
}

/** Ortega Lawn, from the yard at 100 Bridge Rd, with Carlos on its crew and Maria Alvarez at 412 Oak St. */
async function business() {
  const posts: Array<{ memberId: string; text: string }> = [];
  const post: Poster = async (_orgId, memberId, payload) => {
    posts.push({ memberId, text: payload.text ?? "" });
    return { posted: true };
  };
  const owner = await person("Pat Ortega", "owner", "+15555550101");
  const crew = await person("Carlos Reyes", "member", "+15555550102");
  await updateProfile(TEST_ORG, { name: "Ortega Lawn", timeZone: TZ, address: "100 Bridge Rd, Tequesta, FL" }, owner.memberId);
  const maria = await saveCustomer(TEST_ORG, { name: "Maria Alvarez", address: "412 Oak St" }, owner.memberId);
  return { owner, crew, maria, posts, post };
}

const recurrenceOf = async (jobId: string) => (await db().select().from(serviceJobs).where(eq(serviceJobs.id, jobId)))[0].recurrence;

withTestDb("recurring work: booking it weekly records the visit's weekday, time, and length, and every view says so", async () => {
  const { owner, crew, maria, post } = await business();
  const booked = await bookVisit(
    owner,
    { title: "412 Oak St", customerId: maria.id, propertyId: maria.properties[0].id, memberIds: [crew.memberId], day: "2026-11-10", time: "09:00", durationMinutes: 45, recurring: "weekly" },
    { now: NOW, post },
  );
  assert.deepEqual(await recurrenceOf(booked.visit.jobId), { every: "week", weekday: 2, time: "09:00", durationMinutes: 45 });
  assert.equal(visitForTool(booked.visit, TZ, "en").recurring, "Every week on Tuesdays at 9 AM");
  assert.equal(visitForTool(booked.visit, TZ, "es").recurring?.startsWith("Cada semana, los martes a las 9"), true);
  const job = await getServiceJob(owner, booked.visit.jobId);
  assert.equal(jobRecurrenceText(job!, TZ, "en"), "Every week on Tuesdays at 9 AM");

  // Every other week keeps the day and time; "none" stops it, and the visit booked stays for the owner to decide.
  await setRecurrence(owner, { jobId: booked.visit.jobId, recurring: "biweekly" }, { now: NOW });
  assert.deepEqual(await recurrenceOf(booked.visit.jobId), { every: "two_weeks", weekday: 2, time: "09:00", durationMinutes: 45 });
  const stopped = await setRecurrence(owner, { jobId: booked.visit.jobId, recurring: "none" }, { now: NOW });
  assert.equal(await recurrenceOf(booked.visit.jobId), null);
  assert.equal(stopped.nextVisit?.visitId, booked.visit.visitId);
  assert.equal(visitForTool(stopped.nextVisit!, TZ, "en").recurring, undefined);
  await assert.rejects(setRecurrence(crew, { jobId: booked.visit.jobId, recurring: "weekly" }), /NOT_PRIVILEGED/);
});

withTestDb("recurring work: opened monthly with no visit, its first visit sets the day and time", async () => {
  const { owner, crew, post } = await business();
  const { job } = await createServiceJob(owner, { title: "4 Elm Rd", recurring: "monthly" }, { now: NOW });
  assert.deepEqual(job.recurrence, { every: "month" });
  assert.equal(jobRecurrenceText(job, TZ, "en"), "Every month");
  await bookVisit(owner, { jobId: job.id, memberIds: [crew.memberId], day: "2026-11-11", time: "10:00" }, { now: NOW, post });
  assert.deepEqual(await recurrenceOf(job.id), { every: "month", weekday: 3, time: "10:00", durationMinutes: 60 });
  assert.equal(jobRecurrenceText((await getServiceJob(owner, job.id))!, TZ, "en"), "Every month on the 2nd Wednesday at 10 AM");
});

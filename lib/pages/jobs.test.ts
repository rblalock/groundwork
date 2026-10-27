import assert from "node:assert/strict";
import { threadFor, upsertThread } from "../../core/conversations";
import { getOwnJob, openJob } from "../../core/jobs";
import { saveItems } from "../../core/pricebook";
import { createQuote } from "../../core/quotes";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { POST as jobRoute } from "../../app/api/jobs/[id]/route";
import { HttpError } from "../guards";
import { jobFor, jobsOn, myJobs } from "./jobs";
import { appCaller, call, installTransport, otherBusiness, person, refused, signIn, superAdminViewing } from "./test-support";

/** An owner and a crew member, each with a thread and a job, the crew's about their own quote. */
async function seed() {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const crew = await person("Sam Crew", "member", "+15555550102");
  for (const member of [owner, crew]) await upsertThread(TEST_ORG, member.memberId, `ses_${member.memberId}`);
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.memberId);
  const crewQuote = await createQuote({ title: "5 Sample Ln", lines: [{ itemId: item.id, quantity: 3 }] }, crew, { post: async () => ({ posted: true }) });
  const crewJob = await openJob(crew, { id: "job_crew", thread: (await threadFor(TEST_ORG, crew.memberId))!, title: "5 Sample Ln", quoteId: crewQuote.quoteId });
  const crewLoose = await openJob(crew, { id: "job_loose", thread: (await threadFor(TEST_ORG, crew.memberId))!, title: "Something else" });
  const ownerJob = await openJob(owner, { id: "job_owner", thread: (await threadFor(TEST_ORG, owner.memberId))!, title: "Owner's job" });
  return { owner, crew, crewQuote, crewJob, crewLoose, ownerJob };
}

const missing = (promise: Promise<unknown>) =>
  assert.rejects(promise, (error: unknown) => error instanceof HttpError && error.status === 404);

withTestDb("members list their own jobs; an owner reads a crew job about a quote; crew read only their own", async () => {
  const { owner, crew, crewQuote, crewJob, crewLoose, ownerJob } = await seed();
  const ownerApp = await appCaller(await signIn(owner.phoneE164!));
  const crewApp = await appCaller(await signIn(crew.phoneE164!));

  assert.deepEqual((await myJobs(ownerApp)).map((j) => j.jobId), [ownerJob.id]);
  assert.deepEqual((await myJobs(crewApp)).map((j) => j.jobId).sort(), [crewJob.id, crewLoose.id].sort());

  const own = await jobFor(crewApp, crewJob.id);
  assert.equal(own.mine, true);
  assert.equal(own.listing.quoteTitle, "5 Sample Ln");
  const read = await jobFor(ownerApp, crewJob.id);
  assert.equal(read.mine, false);
  assert.equal(read.listing.memberName, "Sam Crew");
  await missing(jobFor(ownerApp, crewLoose.id));
  await missing(jobFor(crewApp, ownerJob.id));
  await missing(jobFor(crewApp, "job_nope"));

  assert.deepEqual((await jobsOn(ownerApp, { quoteId: crewQuote.quoteId })).map((j) => j.jobId), [crewJob.id]);
  assert.deepEqual((await jobsOn(crewApp, { quoteId: crewQuote.quoteId })).map((j) => j.jobId), [crewJob.id]);
});

withTestDb("another business and a super admin's view see no jobs", async () => {
  const { crewJob, crewQuote } = await seed();
  const other = await otherBusiness();
  const outsider = await person("Lee Outsider", "owner", "+15555550109", other);
  const outsiderApp = await appCaller(await signIn(outsider.phoneE164!));
  assert.deepEqual(await myJobs(outsiderApp), []);
  await missing(jobFor(outsiderApp, crewJob.id));
  assert.deepEqual(await jobsOn(outsiderApp, { quoteId: crewQuote.quoteId }), []);

  const admin = await appCaller(await superAdminViewing(TEST_ORG));
  assert.deepEqual(await myJobs(admin), []);
  await missing(jobFor(admin, crewJob.id));
  assert.deepEqual(await jobsOn(admin, { quoteId: crewQuote.quoteId }), []);
});

withTestDb("only a job's member marks it done, archives, or reopens it", async () => {
  const { owner, crew, crewJob } = await seed();
  const crewHeaders = await signIn(crew.phoneE164!);
  const ownerHeaders = await signIn(owner.phoneE164!);

  refused(await call(jobRoute, ownerHeaders, { params: { id: crewJob.id }, body: { status: "done" } }), 404);
  refused(await call(jobRoute, crewHeaders, { params: { id: crewJob.id }, body: { status: "running" } }), 400, "INVALID_INPUT");
  const done = await call(jobRoute, crewHeaders, { params: { id: crewJob.id }, body: { status: "done" } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await getOwnJob(TEST_ORG, crew.memberId, crewJob.id))?.status, "done");
  await call(jobRoute, crewHeaders, { params: { id: crewJob.id }, body: { status: "active" } });
  assert.equal((await getOwnJob(TEST_ORG, crew.memberId, crewJob.id))?.status, "active");

  const admin = await superAdminViewing(TEST_ORG);
  refused(await call(jobRoute, admin, { params: { id: crewJob.id }, body: { status: "done" } }), 403, "NOT_A_MEMBER");
});

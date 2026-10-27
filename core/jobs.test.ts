// Jobs: side conversations a member's thread opens for one piece of work. The assistant drives them
// through a runner (eve's own channel in production; a fake here). Every job is one member's, in one
// business, and a job can't open jobs.
process.env.BLOB_FAKE = "1";
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-0";

import assert from "node:assert/strict";
import { afterEach } from "node:test";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import { jobTurnContext, memberAuth, webTurnContext } from "./channel-dispatch";
import { upsertThread } from "./conversations";
import { saveCustomer } from "./customers";
import type { JobClaims } from "./job-token";
import {
  callingThread,
  getOwnJob,
  isJobAuth,
  jobsAbout,
  listJobs,
  mayReadJob,
  openJob,
  runJobTurn,
  setJobRunnerForTests,
  threadJobEvents,
  type JobRunner,
} from "./jobs";
import { addPhone, APP_JOB, createMember, jobPrincipalId, recordInbound, resolveCaller, type Caller, type Member } from "./members";
import { createOrganization } from "./organizations";
import { saveItems } from "./pricebook";
import { createQuote } from "./quotes";
import { TEST_ORG, withTestDb } from "./test-db";
import { ClientError } from "eve/client";
import startJob from "../agents/assistant/agent/tools/start_job";
import continueJob from "../agents/assistant/agent/tools/continue_job";
import listJobsTool from "../agents/assistant/agent/tools/list_jobs";
import closeJob from "../agents/assistant/agent/tools/close_job";

type Sent = { claims: JobClaims; sessionId: string; message: string };
let created: JobClaims[] = [];
let sent: Sent[] = [];
let failNext = false;

const fakeRunner: JobRunner = {
  async createSession(claims) {
    created.push(claims);
    return `ses_job_${created.length}`;
  },
  async send(claims, sessionId, message) {
    sent.push({ claims, sessionId, message });
    if (failNext) {
      failNext = false;
      return { status: "failed", reply: null };
    }
    return { status: "replied", reply: `Job heard: ${message.split("\n")[0]}` };
  },
};

function install() {
  created = [];
  sent = [];
  failNext = false;
  setJobRunnerForTests(fakeRunner);
}
afterEach(() => setJobRunnerForTests(null));

async function texter(name: string, role: Member["role"], phone: string, orgId = TEST_ORG) {
  const member = await createMember({ orgId, name, role });
  const row = await addPhone(orgId, member.id, phone);
  await recordInbound(orgId, row.id, `imessage:${phone}`, new Date(), "iMessage");
  const thread = (await upsertThread(orgId, member.id, `ses_thread_${member.id}`)).conversation;
  const caller: Caller = { orgId, memberId: member.id, name, role, language: "en", phoneE164: phone };
  return { member, phone: row, thread, caller, auth: memberAuth(member, row) };
}

type DynamicTool = { events: { "turn.started": (event: unknown, ctx: unknown) => unknown } };
type ResolvedTool = { inputSchema: z.ZodType; execute: (input: unknown, ctx: unknown) => Promise<Record<string, any>> };

/** Resolves a thread-only tool for this turn's auth, as eve does at `turn.started`. Null when it's hidden. */
function resolve(tool: unknown, sessionId: string, current: SessionAuthContext | null): ResolvedTool | null {
  return (tool as DynamicTool).events["turn.started"](undefined, { session: { id: sessionId, auth: { current } } }) as ResolvedTool | null;
}

let calls = 0;
async function run(tool: unknown, input: unknown, sessionId: string, current: SessionAuthContext, callId = `call_${++calls}`) {
  const resolved = resolve(tool, sessionId, current);
  assert.ok(resolved, "the tool is available in this conversation");
  const ctx = { session: { id: sessionId, auth: { current } }, callId, abortSignal: new AbortController().signal };
  return resolved.execute(resolved.inputSchema.parse(input), ctx);
}

const jobAuth = (member: Member, conversationId: string): SessionAuthContext => ({
  authenticator: APP_JOB,
  principalId: jobPrincipalId(member.id),
  principalType: "user",
  attributes: { orgId: member.orgId, memberId: member.id, conversationId, conversationKind: "job" },
});

withTestDb("a thread opens, lists, continues, and closes a job, and records each step in the thread", async () => {
  install();
  const owner = await texter("Pat Owner", "owner", "+15555550101");
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.member.id);
  const customer = await saveCustomer(TEST_ORG, { name: "Sam Placeholder", address: "9 Sample Rd" }, owner.member.id);
  const quote = await createQuote({ title: "9 Sample Rd", customerId: customer.id, lines: [{ itemId: item.id, quantity: 4 }] }, owner.caller, {
    post: async () => ({ posted: true }),
  });
  const threadSession = owner.thread.eveSessionId!;

  const opened = await run(
    startJob,
    { title: "9 Sample Rd", notes: "they want the back too, and a revised quote", quoteId: quote.quoteId, customerId: customer.id },
    threadSession,
    owner.auth,
    "call_open",
  );
  assert.equal(opened.status, "replied", JSON.stringify(opened));
  assert.equal(opened.reply, "Job heard: they want the back too, and a revised quote");
  assert.match(opened.guidance, /Don't mention the job's id/);
  const jobId = opened.jobId as string;

  // The job runs as the member, in its own session, with the notes verbatim and what it's about.
  assert.deepEqual(created, [{ orgId: TEST_ORG, memberId: owner.member.id, conversationId: jobId }]);
  assert.equal(sent[0].sessionId, "ses_job_1");
  // The notes go in as said; what the job is about rides in its context, not in the member's words.
  assert.equal(sent[0].message, "they want the back too, and a revised quote");
  const job = await getOwnJob(TEST_ORG, owner.member.id, jobId);
  assert.equal(job?.kind, "job");
  assert.equal(job?.parentId, owner.thread.id);
  assert.equal(job?.eveSessionId, "ses_job_1");
  assert.equal(job?.status, "active");
  assert.equal(job?.quoteId, quote.quoteId);

  // A replayed tool call reaches the same job and doesn't open a second one.
  const replay = await run(startJob, { title: "9 Sample Rd", notes: "they want the back too" }, threadSession, owner.auth, "call_open");
  assert.equal(replay.jobId, jobId);
  assert.equal(created.length, 1, "no second session");
  assert.equal((await listJobs(TEST_ORG, owner.member.id)).length, 1);

  const listed = await run(listJobsTool, {}, threadSession, owner.auth);
  assert.deepEqual(
    listed.jobs.map((j: Record<string, unknown>) => [j.jobId, j.title, j.status, j.quoteTitle, j.customerName]),
    [[jobId, "9 Sample Rd", "active", "9 Sample Rd", "Sam Placeholder"]],
  );

  const next = await run(continueJob, { jobId, message: "make it 6 widgets" }, threadSession, owner.auth);
  assert.equal(next.reply, "Job heard: make it 6 widgets");
  assert.equal(sent.at(-1)?.sessionId, "ses_job_1", "the same session");

  failNext = true;
  const failed = await run(continueJob, { jobId, message: "and the gate" }, threadSession, owner.auth);
  assert.equal(failed.status, "failed");
  assert.match(failed.guidance, /didn't go through/);
  assert.equal((await getOwnJob(TEST_ORG, owner.member.id, jobId))?.status, "failed");

  const closed = await run(closeJob, { jobId }, threadSession, owner.auth);
  assert.equal(closed.status, "done");
  assert.deepEqual(await listJobs(TEST_ORG, owner.member.id), [], "done jobs aren't open");
  assert.equal((await listJobs(TEST_ORG, owner.member.id, { include: "all" })).length, 1);

  // Continuing a done job reopens it; an archived one can't be continued.
  await run(continueJob, { jobId, message: "one more thing" }, threadSession, owner.auth);
  assert.equal((await getOwnJob(TEST_ORG, owner.member.id, jobId))?.status, "active");
  await run(closeJob, { jobId, status: "archived" }, threadSession, owner.auth);
  assert.match((await run(continueJob, { jobId, message: "hello?" }, threadSession, owner.auth)).error, /JOB_ARCHIVED/);

  const recorded = await threadJobEvents(TEST_ORG, owner.thread.id);
  assert.deepEqual(
    recorded.map((e) => [e.kind, e.jobId, e.data.status ?? null]),
    [
      ["job.opened", jobId, null],
      ["job.replied", jobId, "replied"],
      ["job.replied", jobId, "replied"],
      ["job.replied", jobId, "failed"],
      ["job.done", jobId, null],
      ["job.replied", jobId, "replied"],
      ["job.archived", jobId, null],
    ],
  );
  assert.equal(recorded[1].data.reply, "Job heard: they want the back too, and a revised quote");
});

withTestDb("a job is its member's alone: another member or business can't list, continue, or close it, or link into another business", async () => {
  install();
  const owner = await texter("Pat Owner", "owner", "+15555550101");
  const crew = await texter("Sam Crew", "member", "+15555550102");
  const other = await createOrganization({ name: "Other Example", slug: "other-example" });
  const outsider = await texter("Lee Outsider", "owner", "+15555550103", other.id);

  const opened = await run(startJob, { title: "Crew job", notes: "help with this one" }, crew.thread.eveSessionId!, crew.auth);
  const jobId = opened.jobId as string;

  for (const someone of [owner, outsider]) {
    const session = someone.thread.eveSessionId!;
    assert.deepEqual((await run(listJobsTool, { include: "all" }, session, someone.auth)).jobs, []);
    assert.match((await run(continueJob, { jobId, message: "hi" }, session, someone.auth)).error, /JOB_NOT_FOUND/);
    assert.match((await run(closeJob, { jobId }, session, someone.auth)).error, /JOB_NOT_FOUND/);
    assert.equal(await getOwnJob(someone.member.orgId, someone.member.id, jobId), null);
  }
  assert.equal(sent.length, 1, "only the crew member's own turn reached the job");
  assert.equal((await getOwnJob(TEST_ORG, crew.member.id, jobId))?.status, "active");

  // Links stay inside the business: crew link to anyone's quote, nobody to another business's.
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.member.id);
  const ownersQuote = await createQuote({ title: "1 Example St", lines: [{ itemId: item.id, quantity: 2 }] }, owner.caller, { post: async () => ({ posted: true }) });
  const [otherItem] = await saveItems(other.id, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 900 }], outsider.member.id);
  const outsidersQuote = await createQuote({ title: "1 Example St", lines: [{ itemId: otherItem.id, quantity: 2 }] }, outsider.caller, { post: async () => ({ posted: true }) });
  const outsidersCustomer = await saveCustomer(other.id, { name: "Ada Sample" }, outsider.member.id);
  const crewSession = crew.thread.eveSessionId!;
  assert.ok((await run(startJob, { title: "x", notes: "x", quoteId: ownersQuote.quoteId }, crewSession, crew.auth)).jobId);
  assert.match((await run(startJob, { title: "x", notes: "x", quoteId: outsidersQuote.quoteId }, owner.thread.eveSessionId!, owner.auth)).error, /QUOTE_NOT_FOUND/);
  assert.match((await run(startJob, { title: "x", notes: "x", customerId: outsidersCustomer.id }, owner.thread.eveSessionId!, owner.auth)).error, /CUSTOMER_NOT_FOUND/);
  assert.ok((await run(startJob, { title: "y", notes: "y", quoteId: ownersQuote.quoteId }, owner.thread.eveSessionId!, owner.auth)).jobId);

  // A job token's principal must be the member it names; anyone else is nobody.
  const job = (await getOwnJob(TEST_ORG, crew.member.id, jobId))!;
  assert.equal((await resolveCaller(jobAuth(crew.member, jobId)))?.memberId, crew.member.id);
  assert.equal(await resolveCaller({ ...jobAuth(crew.member, jobId), principalId: jobPrincipalId(owner.member.id) }), null);
  assert.equal(await resolveCaller({ ...jobAuth(crew.member, jobId), attributes: { orgId: other.id, memberId: crew.member.id } }), null);

  // Who may read a job they don't own: an owner or admin, only for one about a quote or customer.
  assert.equal(mayReadJob(owner.caller, job), false, "not about a quote or customer");
  assert.equal(mayReadJob(outsider.caller, job), false);
});

withTestDb("owners see crew jobs about a quote, crew see only their own, and no one sees another business's", async () => {
  install();
  const owner = await texter("Pat Owner", "owner", "+15555550101");
  const crew = await texter("Sam Crew", "member", "+15555550102");
  const crew2 = await texter("Lee Crew", "member", "+15555550103");
  const other = await createOrganization({ name: "Other Example", slug: "other-example" });
  const outsider = await texter("Ola Outsider", "owner", "+15555550104", other.id);
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.member.id);
  const crewQuote = await createQuote({ title: "5 Sample Ln", lines: [{ itemId: item.id, quantity: 3 }] }, crew.caller, { post: async () => ({ posted: true }) });

  const crewJob = await openJob(crew.caller, { id: "job_crew", thread: crew.thread, title: "5 Sample Ln", quoteId: crewQuote.quoteId });
  const ownerJob = await openJob(owner.caller, { id: "job_owner", thread: owner.thread, title: "5 Sample Ln, owner", quoteId: crewQuote.quoteId });

  const ids = async (caller: Caller) => (await jobsAbout(caller, { quoteId: crewQuote.quoteId })).map((j) => j.jobId).sort();
  assert.deepEqual(await ids(owner.caller), ["job_crew", "job_owner"]);
  assert.deepEqual(await ids(crew.caller), ["job_crew"]);
  assert.deepEqual(await ids(crew2.caller), []);
  assert.deepEqual(await ids(outsider.caller), []);
  assert.equal(mayReadJob(owner.caller, crewJob), true);
  assert.equal(mayReadJob(crew.caller, ownerJob), false);
  assert.equal(mayReadJob(crew2.caller, crewJob), false);
  assert.equal(mayReadJob(outsider.caller, crewJob), false);
});

withTestDb("a job can't open, list, continue, or close jobs", async () => {
  install();
  const owner = await texter("Pat Owner", "owner", "+15555550101");
  const opened = await run(startJob, { title: "First", notes: "first" }, owner.thread.eveSessionId!, owner.auth);
  const job = (await getOwnJob(TEST_ORG, owner.member.id, opened.jobId))!;

  // Inside the job, as the assistant drives it or as the member chats in it on the web, the tools don't exist.
  const inJob = jobAuth(owner.member, job.id);
  const webInJob: SessionAuthContext = {
    authenticator: "app-web",
    principalId: "usr_x",
    principalType: "user",
    attributes: { orgId: TEST_ORG, memberId: owner.member.id, conversationId: job.id, conversationKind: "job" },
  };
  assert.equal(isJobAuth(inJob), true);
  assert.equal(isJobAuth(webInJob), true);
  assert.equal(isJobAuth(owner.auth), false);
  for (const tool of [startJob, continueJob, listJobsTool, closeJob]) {
    assert.equal(resolve(tool, job.eveSessionId!, inJob), null);
    assert.equal(resolve(tool, job.eveSessionId!, webInJob), null);
    assert.ok(resolve(tool, owner.thread.eveSessionId!, owner.auth));
  }

  // And if a call got through anyway, the library refuses: by the auth, or by the session being a job's.
  await assert.rejects(callingThread(owner.caller, inJob, job.eveSessionId!), /JOB_IN_JOB/);
  await assert.rejects(callingThread(owner.caller, owner.auth, job.eveSessionId!), /JOB_IN_JOB/);
  await assert.rejects(openJob(owner.caller, { id: "job_nested", thread: job, title: "Nested" }), /JOB_IN_JOB/);
  assert.equal(await getOwnJob(TEST_ORG, owner.member.id, "job_nested"), null);

  // A thread session nobody tracks yet (local dev) resolves to the member's thread.
  assert.equal((await callingThread(owner.caller, owner.auth, "ses_untracked")).id, owner.thread.id);
});

withTestDb("a job's turns say which job they're in; the thread's turns list the member's open jobs", async () => {
  install();
  const owner = await texter("Pat Owner", "owner", "+15555550101");
  const job = await openJob(owner.caller, { id: "job_ctx", thread: owner.thread, title: "9 Sample Rd" });

  const driven = await jobTurnContext(jobAuth(owner.member, job.id));
  assert.match(driven[0], /^Member: Pat Owner \(owner\)/);
  assert.match(driven.join("\n"), /This is a thread \(a job\): .*"9 Sample Rd"/);
  assert.match(driven.at(-1)!, /relays your reply/);

  const webJob = await webTurnContext({
    authenticator: "app-web",
    principalId: "usr_none",
    principalType: "user",
    attributes: { orgId: TEST_ORG, memberId: owner.member.id, conversationId: job.id, conversationKind: "job" },
  });
  assert.deepEqual(webJob, [], "the web principal must be the member's own login");

  // Someone else's job, or another business's member, gets no job context.
  const crew = await texter("Sam Crew", "member", "+15555550102");
  assert.deepEqual(await jobTurnContext({ ...jobAuth(crew.member, job.id) }), []);

  const { contextLines } = await import("./inbound");
  const lines = contextLines({ caller: owner.caller, pending: [], lastProactive: null, now: new Date(), openJobs: [{ jobId: job.id, title: job.title! }] });
  assert.match(lines.join("\n"), /Their open jobs: "9 Sample Rd" \(job_ctx\)\. When their message is about one of these, continue it with continue_job\./);
});

withTestDb("a quote made or revised inside a job links the job to it; outside a job nothing changes", async () => {
  install();
  const owner = await texter("Pat Owner", "owner", "+15555550101");
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.member.id);
  const customer = await saveCustomer(TEST_ORG, { name: "Sam Placeholder" }, owner.member.id);
  const job = await openJob(owner.caller, { id: "job_link", thread: owner.thread, title: "9 Sample Rd" });
  const other = await openJob(owner.caller, { id: "job_other", thread: owner.thread, title: "Elsewhere" });
  const { default: createQuoteTool } = await import("../agents/assistant/agent/tools/create_quote");
  const { default: reviseQuoteTool } = await import("../agents/assistant/agent/tools/revise_quote");
  const { setTransportForTests } = await import("./imessage");
  setTransportForTests({ postText: async () => ["sent"], postFile: async () => "file", addReaction: async () => {} });
  try {
    const call = async (tool: unknown, input: unknown, current: SessionAuthContext) => {
      const t = tool as ResolvedTool;
      return t.execute(t.inputSchema.parse(input), { session: { id: "ses_x", auth: { current } } });
    };
    // In the thread, a new quote links no job.
    const inThread = await call(createQuoteTool, { title: "1 Example St", lines: [{ itemId: item.id, quantity: 2 }] }, owner.auth);
    assert.ok(inThread.quoteId, JSON.stringify(inThread));
    assert.equal((await getOwnJob(TEST_ORG, owner.member.id, job.id))?.quoteId, null);

    // In the job (driven by the thread), the quote it starts becomes the job's, with its customer.
    const made = await call(createQuoteTool, { title: "9 Sample Rd", customerId: customer.id, lines: [{ itemId: item.id, quantity: 4 }] }, jobAuth(owner.member, job.id));
    const linked = await getOwnJob(TEST_ORG, owner.member.id, job.id);
    assert.equal(linked?.quoteId, made.quoteId);
    assert.equal(linked?.customerId, customer.id);
    assert.deepEqual((await jobsAbout(owner.caller, { quoteId: made.quoteId })).map((j) => j.jobId), [job.id]);
    // Revising another quote later doesn't move the link.
    await call(reviseQuoteTool, { quoteId: inThread.quoteId, lines: [{ itemId: item.id, quantity: 3 }] }, jobAuth(owner.member, job.id));
    assert.equal((await getOwnJob(TEST_ORG, owner.member.id, job.id))?.quoteId, made.quoteId);
    // Revising an existing quote in another job links that job to it.
    await call(reviseQuoteTool, { quoteId: inThread.quoteId, lines: [{ itemId: item.id, quantity: 5 }] }, jobAuth(owner.member, other.id));
    assert.equal((await getOwnJob(TEST_ORG, owner.member.id, other.id))?.quoteId, inThread.quoteId);
  } finally {
    setTransportForTests(null);
  }

  const { jobContextLines } = await import("./jobs");
  const lines = (j: Parameters<typeof jobContextLines>[0]) => jobContextLines(j, "assistant").join("\n");
  assert.match(lines((await getOwnJob(TEST_ORG, owner.member.id, job.id))!), /change it with revise_quote; don't start a new quote/);
  assert.match(lines({ title: "x", quoteId: null, customerId: null }), /check list_quotes/);
});

withTestDb("a job whose eve session is gone starts a fresh one and runs the turn there", async () => {
  install();
  const { caller, thread } = await texter("Pat Example", "owner", "+15555550111");
  const job = await openJob(caller, { id: "job_gone", thread, title: "Gutters" });
  // The session a turn already ran in, before eve stopped running it.
  await runJobTurn(caller, job.id, "first", { operationId: "op_first" });
  assert.equal((await getOwnJob(TEST_ORG, caller.memberId, job.id))?.eveSessionId, "ses_job_1");

  let stranded = true;
  setJobRunnerForTests({
    ...fakeRunner,
    async send(claims, sessionId, message) {
      if (stranded && sessionId === "ses_job_1") {
        stranded = false;
        throw new ClientError(409, JSON.stringify({ code: "session_stranded", error: "stranded", ok: false }));
      }
      return fakeRunner.send(claims, sessionId, message, { signal: AbortSignal.timeout(1000) });
    },
  });
  const result = await runJobTurn(caller, job.id, "second", { operationId: "op_second" });
  assert.equal(result.status, "replied");
  assert.equal((await getOwnJob(TEST_ORG, caller.memberId, job.id))?.eveSessionId, "ses_job_2", "the job keeps the fresh session");
  assert.deepEqual(sent.map((s) => [s.sessionId, s.message.split("\n")[0]]).slice(-1), [["ses_job_2", "second"]]);

  // Any other failure isn't a reason to drop the session.
  setJobRunnerForTests({ ...fakeRunner, send: async () => { throw new ClientError(500, "boom"); } });
  assert.equal((await runJobTurn(caller, job.id, "third", { operationId: "op_third" })).status, "failed");
  assert.equal((await getOwnJob(TEST_ORG, caller.memberId, job.id))?.eveSessionId, "ses_job_2");
});

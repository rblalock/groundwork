process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-0";
process.env.BLOB_FAKE = "1";

import assert from "node:assert/strict";
import { afterEach } from "node:test";
import { ForbiddenError } from "eve/channels/auth";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import approveQuoteTool from "../agents/assistant/agent/tools/approve_quote";
import reactTool from "../agents/assistant/agent/tools/react";
import {
  handleAssistantMessage,
  handleFailure,
  handleInbound,
  memberAuth,
  trackSession,
  webTurnContext,
  type DispatchDeps,
} from "../core/channel-dispatch";
import { threadFor, upsertThread } from "../core/conversations";
import { setTransportForTests } from "../core/imessage";
import { addPhone, createMember, recordInbound, resolveCaller, type Member, type MemberPhone } from "../core/members";
import { createOrganization } from "../core/organizations";
import { saveCustomer } from "../core/customers";
import { createInvoice } from "../core/invoices";
import { ON_SCREEN_HEADER } from "./on-screen";
import { approveQuotePolicy } from "../core/policies";
import { saveItems } from "../core/pricebook";
import { updateProfile } from "../core/profile";
import { createQuote, getQuote, type Poster } from "../core/quotes";
import { TEST_ORG, withTestDb } from "../core/test-db";
import { createSuperAdmin } from "../scripts/admin-create";
import { auth } from "./auth";
import { DESIGN_PAGE_HEADER, appWebAuth, designerWebAuth, jobRuntimeAuth } from "./eve-auth";
import { ensureAgentSession } from "../core/agent-sessions";
import { designerTurnContext } from "../core/designer";
import { jobToken } from "../core/job-token";
import { getOwnJob, openJob, setJobRunnerForTests, setJobStatus, type JobRunner } from "../core/jobs";
import { removeMember } from "../core/members";
import { webTurnContext as webContext } from "../core/channel-dispatch";
import { getViewer, resolveAppCaller, setActiveBusiness } from "./guards";
import { onScreenRecord } from "./pages/on-screen";
import { settleDeferred } from "../core/deferred";
import { setLoginCodeDepsForTests } from "./phone-code-plugin";

const BASE = "http://localhost:3000";
const OWNER_PHONE = "+15555550101";
const CREW_PHONE = "+15555550142";

let codes: string[] = [];
let texts: Array<{ threadId: string; text: string }> = [];
afterEach(async () => {
  setJobRunnerForTests(null);
  await settleDeferred();
  setLoginCodeDepsForTests(null);
  setTransportForTests(null);
});

function install() {
  codes = [];
  texts = [];
  let n = 0;
  setLoginCodeDepsForTests({
    post: async (_orgId, _memberId, text) => {
      codes.push(text.match(/\b(\d{6})\b/)?.[1] ?? "");
      return { posted: true };
    },
  });
  setTransportForTests({
    postText: async (threadId, text) => {
      texts.push({ threadId, text });
      return [`sent_${++n}`];
    },
    postFile: async () => `file_${++n}`,
    addReaction: async (threadId) => void texts.push({ threadId, text: "(tapback)" }),
  });
}

const quietPoster: Poster = async () => ({ posted: true });

function authPost(path: string, body: unknown, headers: Record<string, string> = {}) {
  return auth().handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, ...headers },
      body: JSON.stringify(body),
    }),
  );
}

const cookieFrom = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

/** A member who has texted the line, with their thread on `sessionId`. */
async function texter(opts: { orgId?: string; phone: string; role?: Member["role"]; sessionId: string; name?: string }) {
  const orgId = opts.orgId ?? TEST_ORG;
  const member = await createMember({ orgId, name: opts.name ?? "Pat Example", role: opts.role ?? "owner" });
  const phone = await addPhone(orgId, member.id, opts.phone);
  await recordInbound(orgId, phone.id, `imessage:${opts.phone}`, new Date(), "iMessage");
  await upsertThread(orgId, member.id, opts.sessionId);
  return { member, phone };
}

async function signIn(phone: string): Promise<string> {
  assert.equal((await authPost("/phone-code/send", { phone })).status, 200);
  await settleDeferred();
  const response = await authPost("/phone-code/verify", { phone, code: codes.at(-1) });
  assert.equal(response.status, 200, await response.clone().text());
  return cookieFrom(response);
}

const appWeb = appWebAuth();
const authenticate = async (request: Request) => appWeb(request);
function eveRequest(path: string, cookie: string | null, method = "POST") {
  return new Request(`${BASE}/eve/v1${path}`, {
    method,
    headers: cookie ? { cookie } : {},
  });
}

async function forbidden(promise: Promise<unknown>, message?: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ForbiddenError, String(error));
    if (message) assert.match(error.message, message);
    return true;
  });
}

withTestDb("a signed-in member acts only on their own thread, as an app-web principal", async () => {
  install();
  const { member } = await texter({ phone: OWNER_PHONE, sessionId: "ses_owner" });
  const crew = await texter({ phone: CREW_PHONE, role: "member", sessionId: "ses_crew", name: "Sam Sample" });
  const cookie = await signIn(OWNER_PHONE);
  const thread = await threadFor(TEST_ORG, member.id);

  const principal = await authenticate(eveRequest("/session/ses_owner", cookie));
  const userId = (await getViewer(new Headers({ cookie })))!.userId;
  // A message starts a turn, so it carries the turn's usage reservation (core/usage-limits.ts).
  const { reservationId, ...attributes } = principal!.attributes;
  assert.match(String(reservationId), /^rsv_/);
  assert.deepEqual({ ...principal, attributes }, {
    authenticator: "app-web",
    principalId: userId,
    principalType: "user",
    attributes: { orgId: TEST_ORG, memberId: member.id, conversationId: thread!.id, conversationKind: "thread" },
  });
  assert.ok(await authenticate(eveRequest("/session/ses_owner/stream", cookie, "GET")));
  assert.ok(await authenticate(eveRequest("/session/ses_owner/cancel", cookie)));

  // Every tool scopes to the member behind the principal.
  const caller = await resolveCaller(principal as SessionAuthContext);
  assert.deepEqual(
    caller && { orgId: caller.orgId, memberId: caller.memberId, role: caller.role, phone: caller.phoneE164 },
    { orgId: TEST_ORG, memberId: member.id, role: "owner", phone: OWNER_PHONE },
  );
  // The member must still be the web login's: a principal for someone else's user is nobody.
  assert.equal(await resolveCaller({ ...(principal as SessionAuthContext), principalId: "usr_other" }), null);
  assert.equal(
    await resolveCaller({ ...(principal as SessionAuthContext), attributes: { orgId: TEST_ORG, memberId: crew.member.id } }),
    null,
  );

  await forbidden(authenticate(eveRequest("/session/ses_crew", cookie)), /isn't yours/);
  await forbidden(authenticate(eveRequest("/session/ses_crew/stream", cookie, "GET")), /isn't yours/);
  await forbidden(authenticate(eveRequest("/session/ses_unknown", cookie)), /isn't yours/);
  await forbidden(authenticate(eveRequest("/session", cookie)), /Text the assistant first/);
  for (const action of ["reset", "clear", "compact"]) {
    await forbidden(authenticate(eveRequest(`/session/ses_owner/${action}`, cookie)), /can't be cleared/);
  }
  // No app session at all: not ours to decide, the walk moves on (localDev in dev, 401 in production).
  assert.equal(await authenticate(eveRequest("/session/ses_owner", null)), null);
  assert.equal(await authenticate(eveRequest("/session/ses_owner", "better-auth.session_token=forged")), null);
});

withTestDb("another business's member can't reach a thread, and a super admin's view is read-only", async () => {
  install();
  await texter({ phone: OWNER_PHONE, sessionId: "ses_a" });
  const other = await createOrganization({ name: "Other Example", slug: "other-example" });
  await texter({ orgId: other.id, phone: CREW_PHONE, sessionId: "ses_b" });
  const cookie = await signIn(CREW_PHONE);
  await forbidden(authenticate(eveRequest("/session/ses_a", cookie)), /isn't yours/);
  assert.ok(await authenticate(eveRequest("/session/ses_b", cookie)));

  await createSuperAdmin("admin@example.test", "a-long-password");
  const signedIn = await authPost("/sign-in/email", { email: "admin@example.test", password: "a-long-password" });
  const adminCookie = cookieFrom(signedIn);
  await setActiveBusiness((await getViewer(new Headers({ cookie: adminCookie })))!, TEST_ORG);
  await forbidden(authenticate(eveRequest("/session/ses_a", adminCookie)), /only members/);
});

async function readyQuote(owner: { member: Member; phone: MemberPhone }) {
  const [widget] = await saveItems(owner.member.orgId, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.member.id);
  const caller = { orgId: owner.member.orgId, memberId: owner.member.id, name: owner.member.name, role: owner.member.role, language: "en" as const, phoneE164: owner.phone.e164 };
  return createQuote({ title: "12 Elm St", lines: [{ itemId: widget.id, quantity: 20 }] }, caller, { post: quietPoster });
}

const webAuth = (member: Member, userId: string): SessionAuthContext => ({
  authenticator: "app-web",
  principalId: userId,
  principalType: "user",
  attributes: { orgId: member.orgId, memberId: member.id, conversationId: "conv_x" },
});

type AnyTool = { inputSchema: unknown; execute: (input: never, ctx: never) => unknown };
async function run(tool: AnyTool, input: unknown, current: SessionAuthContext) {
  const ctx = { session: { auth: { current } } };
  return (await tool.execute((tool.inputSchema as z.ZodType).parse(input) as never, ctx as never)) as Record<string, any>;
}

withTestDb("on the web an ok approves only a quote in the member's business, and only for an owner or admin", async () => {
  install();
  const owner = await texter({ phone: OWNER_PHONE, sessionId: "ses_owner" });
  const crew = await texter({ phone: CREW_PHONE, role: "member", sessionId: "ses_crew", name: "Sam Sample" });
  const ownerUser = (await getViewer(new Headers({ cookie: await signIn(OWNER_PHONE) })))!.userId;
  const crewUser = (await getViewer(new Headers({ cookie: await signIn(CREW_PHONE) })))!.userId;
  const quote = await readyQuote(owner);

  const other = await createOrganization({ name: "Other Example", slug: "other-example" });
  const otherOwner = await texter({ orgId: other.id, phone: "+15555550177", sessionId: "ses_other" });
  const otherUser = (await getViewer(new Headers({ cookie: await signIn("+15555550177") })))!.userId;

  // Crew can't: the tool's approval policy denies them, and the tool refuses.
  const crewAuth = webAuth(crew.member, crewUser);
  const denied = await approveQuotePolicy({ session: { auth: { current: crewAuth } } } as never);
  assert.equal(typeof denied === "object" && denied.type, "denied");
  assert.equal((await run(approveQuoteTool, { quoteId: quote.quoteId }, crewAuth)).reason, "not_privileged");
  // Another business's owner can't see the quote, so can't approve it.
  assert.match((await run(approveQuoteTool, { quoteId: quote.quoteId }, webAuth(otherOwner.member, otherUser))).error, /QUOTE_NOT_FOUND/);
  assert.equal((await getQuote(TEST_ORG, quote.quoteId))?.status, "draft");

  // The owner approves the quote they name on the web.
  const ownerAuth = webAuth(owner.member, ownerUser);
  assert.equal(await approveQuotePolicy({ session: { auth: { current: ownerAuth } } } as never), "not-applicable");
  const approved = await run(approveQuoteTool, { quoteId: quote.quoteId }, ownerAuth);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal((await getQuote(TEST_ORG, quote.quoteId))?.status, "approved");
});

function recorder() {
  const sends: Array<Parameters<DispatchDeps["send"]>> = [];
  const posts: Array<{ threadId: string; text: string }> = [];
  const deps: DispatchDeps = {
    send: async (...args) => void sends.push(args),
    post: async (threadId, text) => {
      posts.push({ threadId, text });
      return [`out_${posts.length}`];
    },
    markRead: async () => {},
    now: new Date(),
  };
  return { sends, posts, deps };
}

withTestDb("a web turn's reply stays on the web; texts still post, and still land in the same thread", async () => {
  install();
  await updateProfile(TEST_ORG, { name: "Acme Widgets" }, "system");
  const owner = await texter({ phone: OWNER_PHONE, sessionId: "ses_owner" });
  const userId = (await getViewer(new Headers({ cookie: await signIn(OWNER_PHONE) })))!.userId;
  const threadId = `imessage:${OWNER_PHONE}`;
  const { sends, posts, deps } = recorder();
  const web = webAuth(owner.member, userId);

  // The Photon channel's events see the web turn too: nothing goes to iMessage.
  const reply = await handleAssistantMessage({ finishReason: "stop", message: "Here are your quotes." }, { state: {}, threadId, auth: web }, deps);
  assert.deepEqual(reply, { posted: false });
  assert.deepEqual(await handleFailure({ threadId, auth: web }, new Error("boom"), deps), { posted: false });
  // Nor does a tapback.
  assert.deepEqual(await run(reactTool, { emoji: "thumbs_up" }, web), { reacted: false });
  await trackSession(web, "ses_owner");
  assert.equal(posts.length + texts.length, 0);

  // A text after web turns dispatches into the same session, and its reply posts.
  const decision = await handleInbound(
    {
      id: "in_1",
      threadId,
      text: "how's 12 Elm St?",
      authorUserId: OWNER_PHONE,
      authorIsBot: false,
      attachments: [],
      service: "iMessage",
      thread: { id: threadId },
    },
    deps,
  );
  assert.deepEqual(decision, { kind: "dispatch", welcome: false });
  assert.equal(sends[0][1].auth.authenticator, "photon-imessage");
  await trackSession(memberAuth(owner.member, owner.phone), "ses_owner");
  assert.equal((await threadFor(TEST_ORG, owner.member.id))?.eveSessionId, "ses_owner");
  const texted = await handleAssistantMessage(
    { finishReason: "stop", message: "12 Elm St is a draft." },
    { state: {}, threadId, auth: memberAuth(owner.member, owner.phone) },
    deps,
  );
  assert.deepEqual(texted, { posted: true });
  assert.deepEqual(posts, [{ threadId, text: "12 Elm St is a draft." }]);
});

withTestDb("a web turn gets the member's context, and says it came from the web", async () => {
  install();
  const owner = await texter({ phone: OWNER_PHONE, sessionId: "ses_owner", name: "Pat Example" });
  const userId = (await getViewer(new Headers({ cookie: await signIn(OWNER_PHONE) })))!.userId;
  const lines = await webTurnContext(webAuth(owner.member, userId));
  assert.match(lines[0], /^Member: Pat Example \(owner\)/);
  assert.match(lines.at(-1)!, /from the web app/);
  assert.deepEqual(await webTurnContext(webAuth(owner.member, "usr_other")), []);
  assert.deepEqual(await webTurnContext(null), []);
});

// ---------------------------------------------------------------------------------------------
// Job sessions

const asCaller = (m: { member: Member; phone: MemberPhone }) => ({
  orgId: m.member.orgId,
  memberId: m.member.id,
  name: m.member.name,
  role: m.member.role,
  language: "en" as const,
  phoneE164: m.phone.e164,
});

async function jobFor(m: { member: Member; phone: MemberPhone }, id: string, links: { quoteId?: string } = {}) {
  const thread = (await threadFor(m.member.orgId, m.member.id))!;
  return openJob(asCaller(m), { id, thread, title: `Job ${id}`, ...links });
}

const setSession = async (orgId: string, jobId: string, sessionId: string) => {
  const { db } = await import("../core/db");
  const { conversations } = await import("../schema/schema");
  const { and, eq } = await import("drizzle-orm");
  await db().update(conversations).set({ eveSessionId: sessionId }).where(and(eq(conversations.orgId, orgId), eq(conversations.id, jobId)));
};

const jobAuth = jobRuntimeAuth();
const jobAuthFn = async (request: Request) => jobAuth(request);
function bearerRequest(path: string, token: string | null, method = "POST") {
  return new Request(`${BASE}/eve/v1${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
}

withTestDb("a job token opens only its job's first session, then only that session, as the member", async () => {
  install();
  const owner = await texter({ phone: OWNER_PHONE, sessionId: "ses_owner" });
  const crew = await texter({ phone: CREW_PHONE, role: "member", sessionId: "ses_crew", name: "Sam Sample" });
  const job = await jobFor(owner, "job_a");
  const claims = { orgId: TEST_ORG, memberId: owner.member.id, conversationId: job.id };
  const token = jobToken(claims);

  // Before the job has a session, the token may create one, and nothing else.
  const principal = await jobAuthFn(bearerRequest("/session", token));
  assert.deepEqual(principal, {
    authenticator: "app-job",
    principalId: `member:${owner.member.id}`,
    principalType: "user",
    attributes: { orgId: TEST_ORG, memberId: owner.member.id, conversationId: job.id, conversationKind: "job" },
  });
  assert.equal((await resolveCaller(principal as SessionAuthContext))?.memberId, owner.member.id);
  await forbidden(jobAuthFn(bearerRequest("/session/ses_owner", token)), /isn't this job's/);
  await forbidden(jobAuthFn(bearerRequest("/info", token, "GET")), /only opens/);

  // Once it has one, the token reaches that session only, and can't create another or clear it.
  await setSession(TEST_ORG, job.id, "ses_job_a");
  assert.ok(await jobAuthFn(bearerRequest("/session/ses_job_a", token)));
  assert.ok(await jobAuthFn(bearerRequest("/session/ses_job_a/stream", token, "GET")));
  await forbidden(jobAuthFn(bearerRequest("/session", token)), /only opens/);
  await forbidden(jobAuthFn(bearerRequest("/session/ses_owner", token)), /isn't this job's/);
  await forbidden(jobAuthFn(bearerRequest("/session/ses_crew", token)), /isn't this job's/);
  for (const action of ["reset", "clear", "compact"]) {
    await forbidden(jobAuthFn(bearerRequest(`/session/ses_job_a/${action}`, token)), /can't be cleared/);
  }

  // Forged, tampered, expired, or re-pointed tokens are refused.
  const [body, sig] = token.slice("gwjob.".length).split(".");
  const tampered = `gwjob.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), memberId: crew.member.id })).toString("base64url")}.${sig}`;
  await forbidden(jobAuthFn(bearerRequest("/session/ses_job_a", tampered)), /isn't valid/);
  await forbidden(jobAuthFn(bearerRequest("/session/ses_job_a", `${token}x`)), /isn't valid/);
  await forbidden(jobAuthFn(bearerRequest("/session/ses_job_a", jobToken(claims, Date.now() - 10 * 60 * 1000))), /isn't valid/);
  // A genuine token naming another member for this job: the job isn't theirs.
  await forbidden(jobAuthFn(bearerRequest("/session/ses_job_a", jobToken({ ...claims, memberId: crew.member.id }))), /isn't theirs/);
  // Another business's id for the same job: nobody's.
  const other = await createOrganization({ name: "Other Example", slug: "other-example" });
  await forbidden(jobAuthFn(bearerRequest("/session/ses_job_a", jobToken({ ...claims, orgId: other.id }))), /isn't active/);

  // An archived job, or a removed member, is closed to the token.
  await setJobStatus(asCaller(owner), job.id, "archived");
  await forbidden(jobAuthFn(bearerRequest("/session/ses_job_a", token)), /archived/);
  const crewJob = await jobFor(crew, "job_c");
  await removeMember(TEST_ORG, crew.member.id);
  await forbidden(jobAuthFn(bearerRequest("/session", jobToken({ orgId: TEST_ORG, memberId: crew.member.id, conversationId: crewJob.id }))), /isn't active/);

  // No job token: not ours to decide. A cookie or another bearer moves on down the walk.
  assert.equal(await jobAuthFn(bearerRequest("/session/ses_job_a", null)), null);
  assert.equal(await jobAuthFn(bearerRequest("/session/ses_job_a", "some-other-token")), null);
});

withTestDb("on the web a member chats in their own jobs; an owner may only read a crew job about a quote", async () => {
  install();
  const owner = await texter({ phone: OWNER_PHONE, sessionId: "ses_owner" });
  const crew = await texter({ phone: CREW_PHONE, role: "member", sessionId: "ses_crew", name: "Sam Sample" });
  const ownerCookie = await signIn(OWNER_PHONE);
  const crewCookie = await signIn(CREW_PHONE);
  const crewQuote = await (async () => {
    const [widget] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.member.id);
    return createQuote({ title: "5 Sample Ln", lines: [{ itemId: widget.id, quantity: 3 }] }, asCaller(crew), { post: quietPoster });
  })();
  const aboutQuote = await jobFor(crew, "job_quote", { quoteId: crewQuote.quoteId });
  const loose = await jobFor(crew, "job_loose");
  const ownerJob = await jobFor(owner, "job_owner");
  await setSession(TEST_ORG, aboutQuote.id, "ses_job_quote");
  await setSession(TEST_ORG, loose.id, "ses_job_loose");
  await setSession(TEST_ORG, ownerJob.id, "ses_job_owner");

  // The crew member writes and reads in their own jobs.
  const mine = await authenticate(eveRequest("/session/ses_job_quote", crewCookie));
  const { reservationId: _reservation, ...mineAttributes } = mine!.attributes;
  assert.deepEqual(mineAttributes, { orgId: TEST_ORG, memberId: crew.member.id, conversationId: aboutQuote.id, conversationKind: "job" });
  assert.ok(await authenticate(eveRequest("/session/ses_job_loose/stream", crewCookie, "GET")));
  // ...but not in the owner's.
  await forbidden(authenticate(eveRequest("/session/ses_job_owner", crewCookie)), /isn't yours/);
  await forbidden(authenticate(eveRequest("/session/ses_job_owner/stream", crewCookie, "GET")), /isn't yours/);

  // The owner may read the crew job about a quote, and only read it.
  const reading = await authenticate(eveRequest("/session/ses_job_quote/stream", ownerCookie, "GET"));
  assert.deepEqual(reading?.attributes, {
    orgId: TEST_ORG,
    memberId: owner.member.id,
    conversationId: aboutQuote.id,
    conversationKind: "job",
    readOnly: "1",
  });
  await forbidden(authenticate(eveRequest("/session/ses_job_quote", ownerCookie)), /isn't yours/);
  await forbidden(authenticate(eveRequest("/session/ses_job_quote/cancel", ownerCookie)), /isn't yours/);
  // A crew job about nothing in particular stays the crew member's.
  await forbidden(authenticate(eveRequest("/session/ses_job_loose/stream", ownerCookie, "GET")), /isn't yours/);

  // Another business's owner reads nothing.
  const other = await createOrganization({ name: "Other Example", slug: "other-example" });
  await texter({ orgId: other.id, phone: "+15555550177", sessionId: "ses_other" });
  const otherCookie = await signIn("+15555550177");
  await forbidden(authenticate(eveRequest("/session/ses_job_quote/stream", otherCookie, "GET")), /isn't yours/);

  // An archived job can be read by its member, not written in.
  await setJobStatus(asCaller(crew), loose.id, "archived");
  assert.ok(await authenticate(eveRequest("/session/ses_job_loose/stream", crewCookie, "GET")));
  await forbidden(authenticate(eveRequest("/session/ses_job_loose", crewCookie)), /archived/);

  // A web turn in a job is told which job it's in, and lists no jobs.
  const lines = await webContext(mine as SessionAuthContext);
  assert.match(lines.join("\n"), /This is a thread \(a job\): .*"Job job_quote", about quote/);
  assert.match(lines.at(-1)!, /wrote this on the web, in the thread itself/);
  // In the thread, the turn lists the member's open jobs.
  const threadAuth = await authenticate(eveRequest("/session/ses_crew", crewCookie));
  const threadLines = await webContext(threadAuth as SessionAuthContext);
  assert.match(threadLines.join("\n"), /Their open jobs: "Job job_quote" \(job_quote\)/);
  assert.match(threadLines.at(-1)!, /from the web app/);
});

withTestDb("a job's first session is created through its runner once, and recorded on the job", async () => {
  install();
  const owner = await texter({ phone: OWNER_PHONE, sessionId: "ses_owner" });
  const job = await jobFor(owner, "job_once");
  let creates = 0;
  const runner: JobRunner = {
    async createSession() {
      creates += 1;
      return "ses_once";
    },
    async send() {
      return { status: "replied", reply: "ok" };
    },
  };
  setJobRunnerForTests(runner);
  const { runJobTurn } = await import("../core/jobs");
  await runJobTurn(asCaller(owner), job.id, "first", { operationId: "op_1" });
  await runJobTurn(asCaller(owner), job.id, "second", { operationId: "op_2" });
  assert.equal(creates, 1);
  assert.equal((await getOwnJob(TEST_ORG, owner.member.id, job.id))?.eveSessionId, "ses_once");
  // The member's web login now reaches it as one of their conversations.
  const cookie = await signIn(OWNER_PHONE);
  assert.ok(await authenticate(eveRequest("/session/ses_once/stream", cookie, "GET")));
});

withTestDb("an email's turn in its thread carries the email's mark and delivery, under the queue's reservation", async () => {
  install();
  const owner = await texter({ phone: OWNER_PHONE, sessionId: "ses_owner" });
  const job = await jobFor(owner, "job_email");
  await setSession(TEST_ORG, job.id, "ses_job_email");
  const token = jobToken({ orgId: TEST_ORG, memberId: owner.member.id, conversationId: job.id, origin: "email", deliveryId: "dlv_1", reservationId: "res_1" });

  // Reading the session: the mark and the delivery ride along; no reservation, since no turn starts.
  const reading = await jobAuthFn(bearerRequest("/session/ses_job_email/stream", token, "GET"));
  assert.deepEqual(reading?.attributes, {
    orgId: TEST_ORG,
    memberId: owner.member.id,
    conversationId: job.id,
    conversationKind: "job",
    origin: "email",
    deliveryId: "dlv_1",
  });
  // Starting the turn: the queue's reservation, not a second one.
  const sending = await jobAuthFn(bearerRequest("/session/ses_job_email", token));
  assert.equal(sending?.attributes.reservationId, "res_1");
  assert.equal(sending?.attributes.origin, "email");

  // A token's email mark can't be added after the fact.
  const plain = jobToken({ orgId: TEST_ORG, memberId: owner.member.id, conversationId: job.id });
  const [body, sig] = plain.slice("gwjob.".length).split(".");
  const marked = `gwjob.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), origin: "email" })).toString("base64url")}.${sig}`;
  await forbidden(jobAuthFn(bearerRequest("/session/ses_job_email", marked)), /isn't valid/);
});

withTestDb("a web message carries the record on screen beside it, only when the member may see it, and the turn names it", async () => {
  install();
  const owner = await texter({ phone: OWNER_PHONE, sessionId: "ses_owner", name: "Pat Example" });
  const crew = await texter({ phone: CREW_PHONE, role: "member", sessionId: "ses_crew", name: "Sam Sample" });
  const quote = await readyQuote(owner);
  const customer = await saveCustomer(TEST_ORG, { name: "Example Customer" }, owner.member.id);
  const ownerCaller = { orgId: TEST_ORG, memberId: owner.member.id, name: owner.member.name, role: owner.member.role, language: "en" as const, phoneE164: owner.phone.e164 };
  const { invoice } = await createInvoice(ownerCaller, { title: "12 Elm St", lines: [{ name: "Sample service", quantity: 1, unitCents: 5000 }] });
  const other = await createOrganization({ name: "Other Example", slug: "other-example" });
  const outsiderOwner = await createMember({ orgId: other.id, name: "Lee Outsider", role: "owner" });
  const outsider = await saveCustomer(other.id, { name: "Someone Else" }, outsiderOwner.id);

  const ownerCookie = await signIn(OWNER_PHONE);
  const crewCookie = await signIn(CREW_PHONE);
  // Through the channel's auth: a message names the quote on screen, and it rides on the turn's principal.
  const request = new Request(`${BASE}/eve/v1/session/ses_owner`, { method: "POST", headers: { cookie: ownerCookie, [ON_SCREEN_HEADER]: `quote:${quote.quoteId}` } });
  const principal = await authenticate(request);
  assert.deepEqual(JSON.parse(String(principal?.attributes.onScreen)), { kind: "quote", id: quote.quoteId, label: "12 Elm St" });

  const callerOf = async (cookie: string) => (await resolveAppCaller((await getViewer(new Headers({ cookie })))!))!;
  const ownerApp = await callerOf(ownerCookie);
  const crewApp = await callerOf(crewCookie);
  assert.deepEqual(await onScreenRecord(ownerApp, `invoice:${invoice.id}`), { kind: "invoice", id: invoice.id, label: `${invoice.label} · 12 Elm St` });
  assert.deepEqual(await onScreenRecord(ownerApp, `customer:${customer.id}`), { kind: "customer", id: customer.id, label: "Example Customer" });
  // Crew see every quote but no invoices; nobody sees another business's records.
  assert.equal(await onScreenRecord(crewApp, `invoice:${invoice.id}`), null);
  assert.deepEqual(await onScreenRecord(crewApp, `quote:${quote.quoteId}`), { kind: "quote", id: quote.quoteId, label: "12 Elm St" });
  assert.deepEqual(await onScreenRecord(crewApp, `customer:${customer.id}`), { kind: "customer", id: customer.id, label: "Example Customer" });
  assert.equal(await onScreenRecord(ownerApp, `customer:${outsider.id}`), null);
  for (const junk of [null, "", "quote", "note:not_1", `quote:${quote.quoteId}:x`, "quote:../x"]) assert.equal(await onScreenRecord(ownerApp, junk), null, String(junk));

  const userId = (await getViewer(new Headers({ cookie: ownerCookie })))!.userId;
  const base = webAuth(owner.member, userId);
  const withQuote = { ...base, attributes: { ...base.attributes, onScreen: JSON.stringify({ kind: "quote", id: quote.quoteId, label: "12 Elm St" }) } };
  assert.match((await webContext(withQuote)).at(-1)!, new RegExp(`quote ${quote.quoteId} "12 Elm St" open on the page beside`));
  assert.doesNotMatch((await webContext(base)).join("\n"), /open on the page beside/);
});

withTestDb("the page designer talks only with owners and admins, in their own conversation about each page", async () => {
  install();
  const { member: owner } = await texter({ phone: OWNER_PHONE, sessionId: "ses_owner" });
  await texter({ phone: CREW_PHONE, role: "member", sessionId: "ses_crew", name: "Sam Sample" });
  const ownerCookie = await signIn(OWNER_PHONE);
  const crewCookie = await signIn(CREW_PHONE);
  const designerAuth = designerWebAuth();
  const designer = async (r: Request) => designerAuth(r);
  const request = (path: string, cookie: string | null, init: { method?: string; page?: string } = {}) =>
    new Request(`${BASE}/eve/designer/v1${path}`, {
      method: init.method ?? "POST",
      headers: { ...(cookie ? { cookie } : {}), ...(init.page ? { [DESIGN_PAGE_HEADER]: init.page } : {}) },
    });

  // Not signed in: not the designer's to answer.
  assert.equal(await designer(request("/session/ses_design", null)), null);
  // Crew never reach it, not even to start a conversation.
  await forbidden(designer(request("/session", crewCookie, { page: "invoice" })), /owner or an admin/);

  // An owner starts their conversation about a page by naming it; nothing else, and only once.
  const created = await designer(request("/session", ownerCookie, { page: "invoice" }));
  assert.equal(created?.attributes.page, "invoice");
  assert.equal(created?.attributes.memberId, owner.id);
  await forbidden(designer(request("/session", ownerCookie)));
  await forbidden(designer(request("/session", ownerCookie, { page: "website" })));
  // Never with a first message: that turn would skip the usage limits.
  const withMessage = new Request(`${BASE}/eve/designer/v1/session`, {
    method: "POST",
    headers: { cookie: ownerCookie, [DESIGN_PAGE_HEADER]: "invoice", "content-type": "application/json" },
    body: JSON.stringify({ message: "make it blue" }),
  });
  await forbidden(designer(withMessage));
  await ensureAgentSession({ orgId: TEST_ORG, memberId: owner.id }, "designer", "invoice", async () => "ses_design");
  await forbidden(designer(request("/session", ownerCookie, { page: "invoice" })), /designer/);

  // Then only that session: its stream, and a message, which carries the turn's usage reservation.
  const streamed = await designer(request("/session/ses_design/stream", ownerCookie, { method: "GET" }));
  assert.equal(streamed?.attributes.page, "invoice");
  assert.equal(streamed?.attributes.reservationId, undefined);
  const sent = await designer(request("/session/ses_design", ownerCookie));
  assert.equal(typeof sent?.attributes.reservationId, "string");
  await forbidden(designer(request("/session/ses_owner", ownerCookie)), /isn't yours/);
  await forbidden(designer(request("/session/ses_design/reset", ownerCookie)), /can't be cleared/);
  await forbidden(designer(request("/session/ses_design", crewCookie)));

  // The assistant's channel doesn't open the designer's session, nor the designer the assistant's thread.
  await forbidden(authenticate(eveRequest("/session/ses_design", ownerCookie)), /isn't yours/);

  // Each turn knows who it's with and which page the conversation is for.
  const context = await designerTurnContext(sent);
  assert.match(context.join("\n"), /Pat Example \(owner\)/);
  assert.match(context.join("\n"), /business's invoice page/);
});

// A paused business, everywhere it's checked: texts, tapbacks, tools, outbound texts, the hourly tick,
// eve's channel auth, the web app's guards and sign-in, and the admin route that pauses it.
import { installTransport, texts, signIn, superAdminViewing, call, refused, appCaller, person } from "./pages/test-support";
import assert from "node:assert/strict";
import { ForbiddenError } from "eve/channels/auth";
import { eq } from "drizzle-orm";
import { followups } from "../schema/schema";
import { POST as suspensionRoute } from "../app/api/admin/businesses/[id]/suspension/route";
import { PATCH as settingsRoute } from "../app/api/settings/route";
import { handleAssistantMessage, handleInbound, handleReaction, memberAuth, type DispatchDeps, type InboundMessage } from "../core/channel-dispatch";
import { upsertThread } from "../core/conversations";
import { db } from "../core/db";
import { queueNotice, runHourlyTick } from "../core/followups";
import { jobToken } from "../core/job-token";
import { openJob } from "../core/jobs";
import { findMemberById, findMemberByPhone } from "../core/members";
import { getOrganization, setSuspended } from "../core/organizations";
import { postToMember } from "../core/outbound";
import { requireCaller, toolError } from "../core/tool-context";
import { TEST_ORG, withTestDb } from "../core/test-db";
import { appWebAuth, jobRuntimeAuth } from "./eve-auth";
import { requestLoginCode } from "./login-codes";

const OWNER = "+15555550101";

function recorder() {
  const sends: Array<Parameters<DispatchDeps["send"]>> = [];
  const posts: string[] = [];
  const deps: DispatchDeps = {
    send: async (...args) => void sends.push(args),
    post: async (_threadId, text) => (posts.push(text), [`out_${posts.length}`]),
    markRead: async () => {},
    now: new Date("2026-10-19T15:00:00Z"),
  };
  return { sends, posts, deps };
}

let seq = 0;
const text = (body: string, from = OWNER): InboundMessage => ({
  id: `in_${++seq}`,
  threadId: `thread:${from}`,
  text: body,
  authorUserId: from,
  authorIsBot: false,
  attachments: [],
  service: "iMessage",
  thread: { id: `thread:${from}` },
});

withTestDb("a paused business's texts start no turn: one polite line a day, STOP still works, tapbacks dropped", async () => {
  const owner = await person("Pat Owner", "owner", OWNER);
  await setSuspended(TEST_ORG, true);
  assert.equal((await getOrganization(TEST_ORG))?.suspended, true);
  const { sends, posts, deps } = recorder();

  assert.deepEqual(await handleInbound(text("quote 100 Example St"), deps), { kind: "ignore", reason: "suspended" });
  assert.deepEqual(await handleInbound(text("hello?"), deps), { kind: "ignore", reason: "suspended" });
  assert.deepEqual(await handleInbound(text("hello?"), { ...deps, now: new Date("2026-10-20T15:00:00Z") }), { kind: "ignore", reason: "suspended" });
  assert.equal(sends.length, 0);
  assert.equal(posts.length, 2, "one line on each day");
  assert.match(posts[0], /assistant is paused for now/);
  assert.deepEqual(
    await handleReaction({ id: "rx_1", threadId: `thread:${OWNER}`, targetMessageId: "out_1", emojiName: "thumbs_up", glyph: "👍", authorUserId: OWNER, thread: {} }, deps),
    { kind: "ignore", reason: "suspended" },
  );
  assert.deepEqual(await handleInbound(text("STOP"), deps), { kind: "stop" });
  assert.equal((await findMemberByPhone(OWNER))?.phone.status, "stopped");

  // A reply to a turn that was already running isn't texted either.
  const member = (await findMemberById(TEST_ORG, owner.memberId))!;
  const phone = (await findMemberByPhone(OWNER))!.phone;
  const posted = await handleAssistantMessage(
    { finishReason: "stop", message: "Here's the quote." },
    { state: {}, threadId: `thread:${OWNER}`, auth: memberAuth(member, { ...phone, status: "verified" }) },
    { post: deps.post, now: deps.now },
  );
  assert.deepEqual(posted, { posted: false });

  // Resumed, texts start turns again.
  await setSuspended(TEST_ORG, false);
  assert.deepEqual(await handleInbound(text("START"), deps), { kind: "start" });
  assert.deepEqual(await handleInbound(text("quote 100 Example St"), deps), { kind: "dispatch", welcome: false });
  assert.equal(sends.length, 1);
});

withTestDb("tools, outbound texts, and the hourly tick skip a paused business", async () => {
  installTransport();
  const owner = await person("Pat Owner", "owner", OWNER);
  const member = (await findMemberById(TEST_ORG, owner.memberId))!;
  const phone = (await findMemberByPhone(OWNER))!.phone;
  await setSuspended(TEST_ORG, true);

  await assert.rejects(requireCaller({ session: { auth: { current: memberAuth(member, phone) } } }), /BUSINESS_SUSPENDED/);
  assert.match(toolError(new Error("BUSINESS_SUSPENDED")).error, /paused/);
  assert.deepEqual(await postToMember(TEST_ORG, owner.memberId, { text: "hello" }, "system"), { posted: false, reason: "suspended" });

  const now = new Date("2026-10-19T15:00:00Z"); // 11:00 in New York: not quiet hours
  await queueNotice({ orgId: TEST_ORG, memberId: owner.memberId, quoteId: null, payload: { text: "A held notice", asksApproval: false }, now: new Date(now.getTime() - 60 * 60_000) });
  assert.deepEqual(await runHourlyTick(now), { nudges: 0, mornings: 0, notices: 0 });
  assert.equal(texts.length, 0);
  assert.equal((await db().select().from(followups).where(eq(followups.orgId, TEST_ORG)))[0].status, "pending", "it waits");

  await setSuspended(TEST_ORG, false);
  assert.equal((await runHourlyTick(now)).notices, 1);
  assert.ok(texts.some((t) => t.text === "A held notice"));
});

withTestDb("the web app and eve's channel auth refuse a paused business; super admins still look", async () => {
  installTransport();
  const owner = await person("Pat Owner", "owner", OWNER);
  const headers = await signIn(OWNER);
  const { conversation: thread } = await upsertThread(TEST_ORG, owner.memberId, "ses_thread");
  const job = await openJob(owner, { id: "job_1", thread, title: "100 Example St" });
  const eveRequest = (sessionId: string, init: { cookie?: string; bearer?: string } = {}) =>
    new Request(`http://localhost:3000/eve/v1/session/${sessionId}/message`, {
      method: "POST",
      headers: { ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}) },
    });
  // Before: both work.
  assert.ok(await appWebAuth()(eveRequest("ses_thread", { cookie: headers.get("cookie")! })));
  const admin = await superAdminViewing(TEST_ORG);

  refused(await call(suspensionRoute, headers, { params: { id: TEST_ORG }, body: { suspended: true } }), 403, "NOT_SUPER_ADMIN");
  const paused = await call(suspensionRoute, admin, { params: { id: TEST_ORG }, body: { suspended: true } });
  assert.equal(paused.status, 200);
  assert.equal((paused.body?.business as { suspended: boolean }).suspended, true);
  refused(await call(suspensionRoute, admin, { params: { id: "org_nope" }, body: { suspended: true } }), 404, "NO_SUCH_BUSINESS");

  // The member's pages and routes refuse; the super admin's view still opens.
  await assert.rejects(appCaller(headers), (error: Error & { code?: string }) => error.code === "BUSINESS_PAUSED");
  refused(await call(settingsRoute, headers, { method: "PATCH", body: { name: "New name" } }), 403, "BUSINESS_PAUSED");
  const view = await appCaller(admin);
  assert.equal(view.suspended, true);

  // eve: the web session and the job token are both refused.
  await assert.rejects(async () => appWebAuth()(eveRequest("ses_thread", { cookie: headers.get("cookie")! })), (e: unknown) => e instanceof ForbiddenError);
  const token = jobToken({ orgId: TEST_ORG, memberId: owner.memberId, conversationId: job.id });
  await assert.rejects(
    async () => jobRuntimeAuth()(new Request("http://localhost:3000/eve/v1/session", { method: "POST", headers: { authorization: `Bearer ${token}` } })),
    (e: unknown) => e instanceof ForbiddenError,
  );

  // A new sign-in code isn't sent.
  const before = texts.length;
  assert.deepEqual(await requestLoginCode(OWNER), { sent: false, reason: "suspended" });
  assert.equal(texts.length, before);

  // Resumed.
  assert.equal((await call(suspensionRoute, admin, { params: { id: TEST_ORG }, body: { suspended: false } })).status, 200);
  assert.equal((await appCaller(headers)).suspended, false);
});

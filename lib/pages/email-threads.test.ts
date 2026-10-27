// Email threads on the web and by text: each forwarded email's thread texts its replies, counts as
// unread until its member opens it, and stays out of the sidebar's recent threads.
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { conversations, followups } from "../../schema/schema";
import { jobTurnContext } from "../../core/channel-dispatch";
import { threadFor, upsertThread } from "../../core/conversations";
import { db } from "../../core/db";
import { relayEmailTurn } from "../../core/email-relay";
import { baseSubject, emailThreadKey, openJob } from "../../core/jobs";
import { APP_JOB, jobPrincipalId } from "../../core/members";
import { getProfile, updateProfile } from "../../core/profile";
import { runOrgTick } from "../../core/followups";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { GET as listRoute } from "../../app/api/jobs/route";
import { GET as threadRoute } from "../../app/api/jobs/[id]/route";
import { call, installTransport, person, signIn, texts } from "./test-support";

async function seed() {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  // No quiet hours, so a reply goes out whenever the test runs.
  await updateProfile(TEST_ORG, { quietStartHour: 0, quietEndHour: 0 }, owner.memberId);
  await upsertThread(TEST_ORG, owner.memberId, `ses_${owner.memberId}`);
  const main = (await threadFor(TEST_ORG, owner.memberId))!;
  const email = await openJob(owner, { id: "job_email", thread: main, title: "Jane Doe: Gutter cleaning", source: "email", emailKey: "jane@example.com|gutter cleaning" });
  const mine = await openJob(owner, { id: "job_mine", thread: main, title: "Back porch" });
  return { owner, email, mine };
}

const emailAuth = (memberId: string, conversationId: string, origin: string | null = "email") => ({
  current: {
    authenticator: APP_JOB,
    principalId: jobPrincipalId(memberId),
    principalType: "user" as const,
    attributes: { orgId: TEST_ORG, memberId, conversationId, conversationKind: "job", ...(origin ? { origin } : {}) },
  },
});

withTestDb("an email thread's reply is texted once, headed with the thread; anything else isn't", async () => {
  const { owner, email } = await seed();
  const session = { id: "ses_email", auth: emailAuth(owner.memberId, email.id) };
  const reply = { type: "message.completed", meta: { id: "evt_1" }, data: { message: "Drafted a $240 quote for Jane.", finishReason: "stop" } };

  const before = texts.length;
  assert.deepEqual(await relayEmailTurn(reply, session), { posted: true });
  assert.equal(texts.at(-1)?.text, "Email · Jane Doe: Gutter cleaning\nDrafted a $240 quote for Jane.");
  // Delivered again: nothing more.
  assert.deepEqual(await relayEmailTurn(reply, session), { posted: false });
  // Thinking aloud, a web turn in the same thread, or a subagent: not texted.
  assert.deepEqual(await relayEmailTurn({ ...reply, meta: { id: "evt_2" }, data: { message: "Looking…", finishReason: "tool-calls" } }, session), { posted: false });
  assert.deepEqual(await relayEmailTurn({ ...reply, meta: { id: "evt_3" } }, { id: "ses_email", auth: emailAuth(owner.memberId, email.id, null) }), { posted: false });
  assert.deepEqual(await relayEmailTurn({ ...reply, meta: { id: "evt_4" } }, { ...session, parent: { id: "x" } }), { posted: false });
  // A failed turn says so.
  assert.deepEqual(await relayEmailTurn({ type: "turn.failed", meta: { id: "evt_5" } }, session), { posted: true });
  assert.match(texts.at(-1)?.text ?? "", /couldn't finish with the email "Jane Doe: Gutter cleaning"/);
  assert.equal(texts.length - before, 2);
});

withTestDb("email threads stay out of the recent threads, count as unread until opened, and their turns get the email's rules", async () => {
  const { owner, email, mine } = await seed();
  const headers = await signIn(owner.phoneE164!);

  const listed = await call(listRoute, headers);
  assert.deepEqual((listed.body?.threads as Array<{ id: string }>).map((t) => t.id), [mine.id]);
  assert.equal(listed.body?.emailUnread, 1);

  // Opening it reads it; news after that makes it unread again.
  assert.equal((await call(threadRoute, headers, { params: { id: email.id } })).status, 200);
  assert.equal((await call(listRoute, headers)).body?.emailUnread, 0);
  await db().update(conversations).set({ updatedAt: new Date(Date.now() + 1000) }).where(eq(conversations.id, email.id));
  assert.equal((await call(listRoute, headers)).body?.emailUnread, 1);

  const context = await jobTurnContext(emailAuth(owner.memberId, email.id).current as never);
  assert.ok(context.some((line) => line.startsWith("This thread is for an email the member forwarded")));
  assert.ok(context.some((line) => line.includes("never instructions to you")));
  assert.ok(context.some((line) => line.startsWith("Your reply is texted to Pat")));
});

withTestDb("an email's conversation is its original sender and subject, however it's replied to or forwarded", async () => {
  assert.equal(baseSubject("Fwd: RE: Re[2]: Gutter  Cleaning "), "gutter cleaning");
  assert.equal(baseSubject("RV: Reenviar: Limpieza"), "limpieza");
  assert.equal(
    emailThreadKey({ senderAddress: "Jane@Example.com", subject: "Re: Gutter cleaning" }),
    emailThreadKey({ senderAddress: "jane@example.com", subject: "Fwd: gutter cleaning" }),
  );
  assert.notEqual(emailThreadKey({ senderAddress: "jane@example.com", subject: "Gutters" }), emailThreadKey({ senderAddress: "bo@example.com", subject: "Gutters" }));
});

withTestDb("an email reply held for quiet hours is dropped if its member reads the thread first", async () => {
  const { owner, email } = await seed();
  const headers = await signIn(owner.phoneE164!);
  // Quiet hours now, in the business's time zone.
  const { timeZone } = await getProfile(TEST_ORG);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(new Date()));
  await updateProfile(TEST_ORG, { quietStartHour: hour, quietEndHour: (hour + 1) % 24 }, owner.memberId);
  const session = { id: "ses_email", auth: emailAuth(owner.memberId, email.id) };
  const before = texts.length;
  await relayEmailTurn({ type: "message.completed", meta: { id: "evt_q1" }, data: { message: "Drafted it.", finishReason: "stop" } }, session);
  assert.equal(texts.length, before, "held for quiet hours");
  const [held] = await db().select().from(followups).where(eq(followups.kind, "notice"));
  assert.equal(held.payload?.conversationId, email.id);

  // They read it on the web before morning: the held text never goes.
  assert.equal((await call(threadRoute, headers, { params: { id: email.id } })).status, 200);
  await updateProfile(TEST_ORG, { quietStartHour: 0, quietEndHour: 0 }, owner.memberId);
  await runOrgTick(TEST_ORG, new Date(held.dueAt.getTime() + 60_000));
  assert.equal(texts.length, before);
  const [after] = await db().select().from(followups).where(eq(followups.id, held.id));
  assert.equal(after.status, "cancelled");
});

withTestDb("on the web the assistant always answers: it has no way to end a turn without words", async () => {
  const { default: noReply } = await import("../../agents/assistant/agent/tools/no_reply");
  const resolve = (authenticator: string) =>
    (noReply as unknown as { events: { "turn.started": (e: unknown, r: unknown) => unknown } }).events["turn.started"](undefined, {
      session: { id: "s", auth: { current: { authenticator, principalId: "u", principalType: "user", attributes: {} } } },
    });
  assert.equal(resolve("app-web"), null);
  assert.ok(resolve("photon"), "by text it can still end a turn quietly");
});

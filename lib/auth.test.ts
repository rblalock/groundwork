process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-0";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { loginCodes, members, messages, session as sessions, user as users } from "../schema/schema";
import { db } from "../core/db";
import { setTransportForTests } from "../core/imessage";
import { addPhone, createMember, recordInbound, removeMember, setPhoneStatus, verifyPhone } from "../core/members";
import { createOrganization } from "../core/organizations";
import { TEST_ORG, withTestDb } from "../core/test-db";
import { auth, superAdminEmailAllowed } from "./auth";
import { createSuperAdmin } from "../scripts/admin-create";
import { HttpError, memberCaller, requireMember, requirePrivileged, requireSuperAdmin, requireViewer, setActiveBusiness, getViewer } from "./guards";
import { MAX_ATTEMPTS, requestLoginCode, verifyLoginCode } from "./login-codes";
import { settleDeferred } from "../core/deferred";
import { setLoginCodeDepsForTests } from "./phone-code-plugin";

const BASE = "http://localhost:3000";
let texts: Array<{ threadId: string; text: string }> = [];

function install() {
  texts = [];
  let n = 0;
  setTransportForTests({
    postText: async (threadId, text) => {
      texts.push({ threadId, text });
      return [`sent_${++n}`];
    },
    postFile: async () => null,
    addReaction: async () => {},
  });
}
afterEach(async () => {
  await settleDeferred();
  setTransportForTests(null);
  setLoginCodeDepsForTests(null);
});

/** A member whose phone has texted the line (verified, with a thread), unless `texted: false`. */
async function member(opts: { orgId?: string; name?: string; role?: "owner" | "admin" | "member"; phone: string; texted?: boolean; language?: "en" | "es" }) {
  const orgId = opts.orgId ?? TEST_ORG;
  const row = await createMember({ orgId, name: opts.name ?? "Pat Example", role: opts.role ?? "owner", language: opts.language });
  const phone = await addPhone(orgId, row.id, opts.phone);
  if (opts.texted !== false) await recordInbound(orgId, phone.id, `thread:${opts.phone}`, new Date(), "iMessage");
  return { member: row, phone };
}

const codeIn = (text: string) => text.match(/\b(\d{6})\b/)?.[1] ?? "";

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return auth().handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, ...headers },
      body: JSON.stringify(body),
    }),
  );
}

/** The session cookie a response set, as a request `cookie` header. */
function cookieFrom(response: Response): string {
  const cookies = response.headers.getSetCookie().map((c) => c.split(";")[0]);
  assert.ok(cookies.length > 0, "a cookie was set");
  return cookies.join("; ");
}

async function signInByPhone(phone: string): Promise<Headers> {
  texts = [];
  assert.equal((await post("/phone-code/send", { phone })).status, 200);
  await settleDeferred();
  const code = codeIn(texts.at(-1)?.text ?? "");
  assert.match(code, /^\d{6}$/);
  const response = await post("/phone-code/verify", { phone, code });
  assert.equal(response.status, 200, await response.clone().text());
  return new Headers({ cookie: cookieFrom(response) });
}

async function rejects(promise: Promise<unknown>, status: number, code?: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HttpError, String(error));
    assert.equal(error.status, status);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

withTestDb("a code goes only to an active member whose phone is verified, in their language, and is stored hashed", async () => {
  install();
  const { member: owner } = await member({ phone: "+15555550101", language: "es" });
  await member({ name: "Never Verified", role: "member", phone: "+15555550102", texted: false });
  const stopped = await member({ name: "Stopped", role: "member", phone: "+15555550103" });
  await setPhoneStatus(TEST_ORG, stopped.phone.id, "stopped");
  const removed = await member({ name: "Removed", role: "member", phone: "+15555550104" });
  await removeMember(TEST_ORG, removed.member.id);

  assert.deepEqual(await requestLoginCode("+15555550199"), { sent: false, reason: "unknown" });
  assert.deepEqual(await requestLoginCode("+15555550102"), { sent: false, reason: "unknown" });
  assert.deepEqual(await requestLoginCode("+15555550103"), { sent: false, reason: "unknown" });
  assert.deepEqual(await requestLoginCode("+15555550104"), { sent: false, reason: "unknown" });
  assert.deepEqual(await requestLoginCode("12"), { sent: false, reason: "invalid_phone" });
  assert.equal(texts.length, 0);

  const result = await requestLoginCode("(555) 555-0101", { generate: () => "123456" });
  assert.deepEqual(result, { sent: true, orgId: TEST_ORG, memberId: owner.id });
  assert.deepEqual(texts, [
    {
      threadId: "thread:+15555550101",
      text: "Tu código para entrar es 123456. Vence en 10 minutos. Si no lo pediste, ignora este mensaje.",
    },
  ]);
  const [row] = await db().select().from(loginCodes);
  assert.equal(row.orgId, TEST_ORG);
  assert.equal(row.memberId, owner.id);
  assert.notEqual(row.codeHash, "123456");
  assert.ok(!row.codeHash.includes("123456"));
  // The thread's log keeps the message but not the code.
  const logged = await db().select().from(messages).where(eq(messages.memberId, owner.id));
  assert.equal(logged.length, 1);
  assert.equal(logged[0].kind, "system");
  assert.ok(!logged[0].body.includes("123456"));
});

withTestDb("a provisioned phone that has never texted gets its code on a thread opened to its number", async () => {
  // No test transport: the fake iMessage mode opens the thread and prints the post.
  const { member: owner, phone } = await member({ phone: "+15555550101", texted: false });
  await verifyPhone(TEST_ORG, phone.id, new Date());
  const result = await requestLoginCode("+15555550101", { generate: () => "123456" });
  assert.deepEqual(result, { sent: true, orgId: TEST_ORG, memberId: owner.id });
  const logged = await db().select().from(messages).where(eq(messages.memberId, owner.id));
  assert.equal(logged.length, 1);
  assert.equal(logged[0].threadId, "fake-dm:+15555550101");
  assert.ok(!logged[0].body.includes("123456"));
  assert.equal((await verifyLoginCode("+15555550101", "123456")).ok, true);
});

withTestDb("a phone gets at most three codes in fifteen minutes, and a new code replaces the old", async () => {
  install();
  await member({ phone: "+15555550101" });
  const now = new Date("2026-10-18T15:00:00Z");
  const codes = ["111111", "222222", "333333", "444444"];
  for (const [i, code] of codes.entries()) {
    const result = await requestLoginCode("+15555550101", { now: new Date(now.getTime() + i * 1000), generate: () => code });
    assert.equal(result.sent, i < 3, `request ${i + 1}`);
  }
  assert.equal(texts.length, 3);
  const later = new Date(now.getTime() + 5000);
  assert.deepEqual(await verifyLoginCode("+15555550101", "111111", { now: later }), { ok: false, reason: "wrong_code" });
  assert.equal((await verifyLoginCode("+15555550101", "333333", { now: later })).ok, true);
  // After the window, a new code can be sent.
  const result = await requestLoginCode("+15555550101", { now: new Date(now.getTime() + 16 * 60 * 1000) });
  assert.equal(result.sent, true);
});

withTestDb("a code is single use, expires in ten minutes, and stops after five wrong tries", async () => {
  install();
  await member({ phone: "+15555550101" });
  const now = new Date("2026-10-18T15:00:00Z");
  const at = (ms: number) => ({ now: new Date(now.getTime() + ms) });

  await requestLoginCode("+15555550101", { now, generate: () => "123456" });
  assert.equal((await verifyLoginCode("+15555550101", "123456", at(1000))).ok, true);
  assert.deepEqual(await verifyLoginCode("+15555550101", "123456", at(2000)), { ok: false, reason: "no_code" });

  await requestLoginCode("+15555550101", { now, generate: () => "222222" });
  assert.deepEqual(await verifyLoginCode("+15555550101", "222222", at(10 * 60 * 1000 + 1)), { ok: false, reason: "no_code" });

  await requestLoginCode("+15555550101", { now: new Date(now.getTime() + 20 * 60 * 1000), generate: () => "333333" });
  const later = at(20 * 60 * 1000 + 1000);
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    assert.deepEqual(await verifyLoginCode("+15555550101", "000000", later), { ok: false, reason: "wrong_code" });
  }
  assert.deepEqual(await verifyLoginCode("+15555550101", "000000", later), { ok: false, reason: "too_many_attempts" });
  // Even the right code is refused now.
  assert.equal((await verifyLoginCode("+15555550101", "333333", later)).ok, false);
});

withTestDb("a member removed after the code went out can't use it", async () => {
  install();
  await member({ phone: "+15555550101" });
  const crew = await member({ name: "Sam Crew", role: "member", phone: "+15555550102" });
  await requestLoginCode("+15555550102", { generate: () => "123456" });
  await removeMember(TEST_ORG, crew.member.id);
  assert.deepEqual(await verifyLoginCode("+15555550102", "123456"), { ok: false, reason: "not_a_member" });
});

withTestDb("sending answers the same for known and unknown phones", async () => {
  install();
  await member({ phone: "+15555550101" });
  const unknown = await post("/phone-code/send", { phone: "+15555550199" });
  const known = await post("/phone-code/send", { phone: "+15555550101" });
  assert.equal(unknown.status, known.status);
  assert.deepEqual(await unknown.json(), await known.json());
  await settleDeferred();
  assert.equal(texts.length, 1);
});

withTestDb("sending answers before the code is looked up, saved, or texted", async () => {
  await member({ phone: "+15555550101" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const posted: string[] = [];
  setLoginCodeDepsForTests({
    post: async (_orgId, _memberId, text) => {
      await gate;
      posted.push(text);
      return { posted: true };
    },
  });
  // The poster is held, so a send that waited for it would never answer.
  const response = await post("/phone-code/send", { phone: "+15555550101" });
  assert.equal(response.status, 200);
  assert.deepEqual(posted, []);
  release();
  await settleDeferred();
  assert.equal(posted.length, 1);
  assert.equal((await db().select().from(loginCodes)).length, 1);
});

withTestDb("verifying signs the member in: the user is created once, linked to the member, and their business is active", async () => {
  install();
  const { member: owner } = await member({ name: "Pat Example", phone: "+15555550101" });
  const bad = await post("/phone-code/verify", { phone: "+15555550101", code: "000000" });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.getSetCookie().length, 0);

  const headers = await signInByPhone("+15555550101");
  const [linked] = await db().select().from(members).where(eq(members.id, owner.id));
  assert.ok(linked.userId);
  const [account] = await db().select().from(users).where(eq(users.id, linked.userId));
  assert.equal(account.name, "Pat Example");
  assert.equal(account.role, null);
  const [row] = await db().select().from(sessions).where(eq(sessions.userId, linked.userId));
  assert.equal(row.activeOrganizationId, TEST_ORG);

  const caller = await requireMember(headers);
  assert.equal(caller.orgId, TEST_ORG);
  assert.equal(caller.memberId, owner.id);
  assert.equal(caller.role, "owner");
  assert.equal(caller.phoneE164, "+15555550101");
  assert.equal(memberCaller(caller).memberId, owner.id);
  assert.equal((await requirePrivileged(headers)).memberId, owner.id);

  // A second sign-in finds the same user.
  await signInByPhone("+15555550101");
  assert.equal((await db().select().from(users)).length, 1);
  assert.equal((await db().select().from(sessions)).length, 2);
});

withTestDb("guards: no session is 401, crew aren't privileged, and a removed member loses the business", async () => {
  install();
  await member({ phone: "+15555550101" });
  const crew = await member({ name: "Sam Crew", role: "member", phone: "+15555550102" });
  await rejects(requireMember(new Headers()), 401, "UNAUTHENTICATED");
  await rejects(requireMember(new Headers({ cookie: "better-auth.session_token=forged" })), 401);

  const headers = await signInByPhone("+15555550102");
  const caller = await requireMember(headers);
  assert.equal(caller.role, "member");
  await rejects(requirePrivileged(headers), 403, "NOT_PRIVILEGED");
  await rejects(requireSuperAdmin(headers), 403, "NOT_SUPER_ADMIN");

  await removeMember(TEST_ORG, crew.member.id);
  await rejects(requireMember(headers), 403, "NO_BUSINESS");
});

withTestDb("a member can't open another business; the session stays on theirs", async () => {
  install();
  await member({ phone: "+15555550101" });
  const other = await createOrganization({ id: "org_other", name: "Other Co", slug: "other-co" });
  await member({ orgId: other.id, name: "Lee Other", phone: "+15555550201" });

  const headers = await signInByPhone("+15555550101");
  const viewer = await requireViewer(headers);
  await rejects(setActiveBusiness(viewer, other.id), 404, "NO_SUCH_BUSINESS");
  // Even a session pointed at another business by hand resolves to the member's own.
  await db().update(sessions).set({ activeOrganizationId: other.id });
  const caller = await requireMember(headers);
  assert.equal(caller.orgId, TEST_ORG);
});

withTestDb("no one can sign up on the web, not even with an admin's email", async () => {
  for (const email of ["someone@example.test", "admin@example.test"]) {
    const refused = await post("/sign-up/email", { email, password: "a-long-password", name: "Someone" });
    assert.equal(refused.status, 403);
  }
  assert.equal((await db().select().from(users)).length, 0);
});

withTestDb("a super admin made by admin:create signs in with a password and can open any business", async () => {
  install();
  const { member: owner } = await member({ phone: "+15555550101" });
  const made = await createSuperAdmin("Admin@Example.test", "a-long-password");
  assert.equal(made.created, true);
  const [row] = await db().select().from(users);
  assert.equal(row.email, "admin@example.test");
  assert.equal(row.role, "super_admin");
  // Rerunning keeps the account and its password.
  assert.deepEqual(await createSuperAdmin("admin@example.test", "another-password"), { created: false });

  const wrong = await post("/sign-in/email", { email: "admin@example.test", password: "another-password" });
  assert.equal(wrong.status, 401);
  const signedIn = await post("/sign-in/email", { email: "admin@example.test", password: "a-long-password" });
  assert.equal(signedIn.status, 200, await signedIn.clone().text());
  const headers = new Headers({ cookie: cookieFrom(signedIn) });
  const viewer = await requireSuperAdmin(headers);
  assert.equal(viewer.superAdmin, true);
  // No business picked yet.
  await rejects(requireMember(headers), 403, "NO_BUSINESS");

  await setActiveBusiness(viewer, TEST_ORG);
  const caller = await requireMember(headers);
  assert.equal(caller.orgId, TEST_ORG);
  assert.equal(caller.memberId, null);
  assert.equal(caller.superAdmin, true);
  assert.equal(caller.role, "owner");
  assert.throws(() => memberCaller(caller), (error: unknown) => error instanceof HttpError && error.code === "NOT_A_MEMBER");
  await rejects(setActiveBusiness(viewer, "org_missing"), 404);
  assert.equal((await getViewer(headers))?.superAdmin, true);
  const [ownerRow] = await db().select().from(members).where(and(eq(members.id, owner.id)));
  assert.equal(ownerRow.userId, null);
});

test("only emails on SUPER_ADMIN_EMAILS are super admins; unset, production allows nobody", () => {
  const env = { SUPER_ADMIN_EMAILS: " Owner@Example.test, second@example.test ", VERCEL_ENV: "production" };
  assert.equal(superAdminEmailAllowed("owner@example.test", env), true);
  assert.equal(superAdminEmailAllowed("SECOND@example.test", env), true);
  assert.equal(superAdminEmailAllowed("someone@example.test", env), false);
  assert.equal(superAdminEmailAllowed("owner@example.test", { VERCEL_ENV: "production" }), false);
  assert.equal(superAdminEmailAllowed("owner@example.test", {}), true);
});

withTestDb("a phone login with the role and a confirmed forwarding email on SUPER_ADMIN_EMAILS is a super admin", async () => {
  install();
  const saved = process.env.SUPER_ADMIN_EMAILS;
  try {
    const { member: owner } = await member({ phone: "+15555550101" });
    const headers = await signInByPhone("+15555550101");
    process.env.SUPER_ADMIN_EMAILS = "owner@example.test";
    // Signed in by phone, but no confirmed email yet: an ordinary owner.
    assert.equal((await getViewer(headers))?.superAdmin, false);
    // Confirmed (email_claims sets it only once an email from it carries the texted code), but no grant.
    await db().update(members).set({ email: "owner@example.test" }).where(eq(members.id, owner.id));
    assert.equal((await getViewer(headers))?.superAdmin, false, "a forwarding email alone grants nothing");
    // An operator grants the role on the phone login.
    const [linked] = await db().select({ userId: members.userId }).from(members).where(eq(members.id, owner.id));
    await db().update(users).set({ role: "super_admin" }).where(eq(users.id, linked.userId!));
    assert.equal((await getViewer(headers))?.superAdmin, true);
    // An address that isn't listed doesn't count. (No list at all: production has no super admins, and
    // local dev any login with the role; see superAdminEmailAllowed.)
    process.env.SUPER_ADMIN_EMAILS = "someone-else@example.test";
    assert.equal((await getViewer(headers))?.superAdmin, false);
    // A removed member's email doesn't count.
    process.env.SUPER_ADMIN_EMAILS = "owner@example.test";
    await db().update(members).set({ status: "removed" }).where(eq(members.id, owner.id));
    assert.equal((await getViewer(headers))?.superAdmin, false);
  } finally {
    if (saved === undefined) delete process.env.SUPER_ADMIN_EMAILS;
    else process.env.SUPER_ADMIN_EMAILS = saved;
  }
});

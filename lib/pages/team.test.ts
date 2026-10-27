import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { memberPhones, members } from "../../schema/schema";
import { db } from "../../core/db";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { POST as addRoute } from "../../app/api/team/route";
import { DELETE as removeRoute, PATCH as emailRoute } from "../../app/api/team/[id]/route";
import { PUT as ownEmailRoute } from "../../app/api/account/email/route";
import { teamFor } from "./team";
import { createBusinessInbox } from "../../core/email-intake";
import { updateProfile } from "../../core/profile";
import { appCaller, call, installTransport, otherBusiness, person, refused, signIn, superAdminViewing, texts } from "./test-support";

async function seed() {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const crew = await person("Sam Crew", "member", "+15555550102");
  const other = await otherBusiness();
  const otherOwner = await person("Kim Other", "owner", "+15555550201", other);
  return { owner, crew, otherOwner };
}

withTestDb("team: owners add someone and get the invite to forward; nobody is texted", async () => {
  const s = await seed();
  const ownerHeaders = await signIn("+15555550101");
  const crewHeaders = await signIn("+15555550102");

  await assert.rejects(teamFor(await appCaller(crewHeaders)), { status: 403 });
  refused(await call(addRoute, crewHeaders, { body: { name: "New Person", phone: "305-555-0150" } }), 403, "NOT_PRIVILEGED");

  const sentBefore = texts.length;
  const added = await call(addRoute, ownerHeaders, { body: { name: "Rae New", phone: "305-555-0150", role: "admin", language: "es" } });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body?.alreadyActive, false);
  assert.match(String(added.body?.invite), /^Rae, soy el asistente de cotizaciones de .+\. Escríbeme al \(555\) 555-0100/);
  assert.equal(texts.length, sentBefore, "the web app texts no one");
  const [phone] = await db().select().from(memberPhones).where(eq(memberPhones.e164, "+13055550150"));
  assert.equal(phone.orgId, TEST_ORG);
  assert.equal(phone.status, "pending");
  assert.ok(phone.photonUserId);

  const team = await teamFor(await appCaller(ownerHeaders));
  assert.deepEqual(
    team.map((m) => [m.name, m.role, m.language, m.hasLogin, m.phones.map((p) => p.status)]),
    [
      ["Pat Owner", "owner", "en", true, ["verified"]],
      ["Sam Crew", "member", "en", true, ["verified"]],
      ["Rae New", "admin", "es", false, ["pending"]],
    ],
  );

  // Someone already texting comes back as already on the team, with no invite.
  const again = await call(addRoute, ownerHeaders, { body: { name: "Sam", phone: "+15555550102" } });
  assert.equal(again.body?.alreadyActive, true);
  assert.equal(again.body?.invite, null);
  // Another business's phone isn't this team's to add.
  refused(await call(addRoute, ownerHeaders, { body: { name: "Kim", phone: "+15555550201" } }), 409, "PHONE_IN_USE");
  refused(await call(addRoute, ownerHeaders, { body: { name: "Bad", phone: "12" } }), 400, "INVALID_PHONE");
  refused(await call(addRoute, ownerHeaders, { body: { name: "Org Hop", phone: "305-555-0151", orgId: "org_other" } }), 400);
});

withTestDb("team: owners remove people, but never the last owner or another business's member", async () => {
  const s = await seed();
  const ownerHeaders = await signIn("+15555550101");
  const crewHeaders = await signIn("+15555550102");

  refused(await call(removeRoute, crewHeaders, { method: "DELETE", params: { id: s.owner.memberId } }), 403, "NOT_PRIVILEGED");
  refused(await call(removeRoute, ownerHeaders, { method: "DELETE", params: { id: s.otherOwner.memberId } }), 404);
  refused(await call(removeRoute, ownerHeaders, { method: "DELETE", params: { id: s.owner.memberId } }), 409, "LAST_OWNER");

  const removed = await call(removeRoute, ownerHeaders, { method: "DELETE", params: { id: s.crew.memberId } });
  assert.equal(removed.status, 200);
  const [row] = await db().select().from(members).where(eq(members.id, s.crew.memberId));
  assert.equal(row.status, "removed");
  // Their web session loses the business at once.
  refused(await call(removeRoute, crewHeaders, { method: "DELETE", params: { id: s.owner.memberId } }), 403, "NO_BUSINESS");
  const [otherOwner] = await db().select().from(members).where(eq(members.id, s.otherOwner.memberId));
  assert.equal(otherOwner.status, "active");
});

withTestDb("team: a super admin looking sees the team and can't add or remove anyone", async () => {
  const s = await seed();
  const headers = await superAdminViewing(TEST_ORG);
  assert.equal((await teamFor(await appCaller(headers))).length, 2);
  refused(await call(addRoute, headers, { body: { name: "Rae New", phone: "305-555-0150" } }), 403, "NOT_A_MEMBER");
  refused(await call(removeRoute, headers, { method: "DELETE", params: { id: s.crew.memberId } }), 403, "NOT_A_MEMBER");
});

withTestDb("team: members ask for their own forwarding email and see its code; owners ask for crew's, who get the code by text; nobody else can", async () => {
  const s = await seed();
  const admin = await person("Ari Admin", "admin", "+15555550103");
  const other = await person("Lee Admin", "admin", "+15555550104");
  const ownerHeaders = await signIn("+15555550101");
  const crewHeaders = await signIn("+15555550102");
  const adminHeaders = await signIn("+15555550103");
  // Without the business's own address there's nothing to confirm to.
  refused(await call(ownEmailRoute, crewHeaders, { method: "PUT", body: { email: "sam@example.com" } }), 409, "EMAIL_NO_INBOX");
  const inbox = await createBusinessInbox(TEST_ORG);

  // Asking for one's own: pending, with its code shown to them (and texted), never on yet.
  const own = await call(ownEmailRoute, crewHeaders, { method: "PUT", body: { email: "Sam@Example.com" } });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  const mine = own.body?.member as { email: string | null; pending: { address: string; inbox: string; code?: string } };
  assert.deepEqual([mine.email, mine.pending.address, mine.pending.inbox], [null, "sam@example.com", inbox.address]);
  assert.match(mine.pending.code ?? "", /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  refused(await call(emailRoute, crewHeaders, { method: "PATCH", params: { id: s.owner.memberId }, body: { email: "x@example.com" } }), 403, "NOT_PRIVILEGED");
  // Nobody asks for the address of someone at or above them: an admin can't make the owner's, or another admin's, their own.
  refused(await call(emailRoute, adminHeaders, { method: "PATCH", params: { id: s.owner.memberId }, body: { email: "ari@example.com" } }), 403, "NOT_PRIVILEGED");
  refused(await call(emailRoute, adminHeaders, { method: "PATCH", params: { id: other.memberId }, body: { email: "ari@example.com" } }), 403, "NOT_PRIVILEGED");
  assert.equal(admin.role, "admin");
  // A pending address is taken, in any case.
  refused(await call(ownEmailRoute, ownerHeaders, { method: "PUT", body: { email: "SAM@example.com" } }), 409, "EMAIL_IN_USE");
  refused(await call(ownEmailRoute, ownerHeaders, { method: "PUT", body: { email: "nope" } }), 400, "INVALID_EMAIL");
  // Another business's member is not this owner's to change.
  refused(await call(emailRoute, ownerHeaders, { method: "PATCH", params: { id: s.otherOwner.memberId }, body: { email: "k@example.com" } }), 404, "MEMBER_NOT_FOUND");

  // The owner asks for crew's: crew get the code by text, any hour; the owner never sees it.
  await updateProfile(TEST_ORG, { quietStartHour: 0, quietEndHour: 23 }, s.owner.memberId);
  const before = texts.length;
  const set = await call(emailRoute, ownerHeaders, { method: "PATCH", params: { id: s.crew.memberId }, body: { email: "sam.crew@example.com" } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const theirs = set.body?.member as { pending: { address: string; code?: string }; codeTexted: boolean };
  assert.deepEqual([theirs.pending.address, "code" in theirs.pending, theirs.codeTexted], ["sam.crew@example.com", false, true]);
  const sent = texts.slice(before);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].threadId, "thread:+15555550102");
  assert.match(sent[0].text, /^Pat set s…@example\.com as your email for forwarding\. To turn it on, send a new email to .+ from that address with just [A-Z2-9]{4}-[A-Z2-9]{4} as the subject \(not a reply or forward\)\. The code works for 24 hours\. Not you\? Tell the owner\.$/);
  const team = await teamFor(await appCaller(ownerHeaders));
  assert.deepEqual(
    [team.find((m) => m.id === s.crew.memberId)?.email, team.find((m) => m.id === s.crew.memberId)?.pendingEmail],
    [null, "sam.crew@example.com"],
  );
  const [row] = await db().select().from(members).where(eq(members.id, s.crew.memberId));
  assert.equal(row.email, null, "nothing turns on until the code comes back by email");

  // A super admin looking can't change anyone's.
  refused(await call(ownEmailRoute, await superAdminViewing(TEST_ORG), { method: "PUT", body: { email: "a@example.com" } }), 403);
});

withTestDb("team: only someone above a member changes them: admins manage crew, the owner admins too, nobody another owner", async () => {
  const s = await seed();
  const admin = await person("Ari Admin", "admin", "+15555550103");
  const otherAdmin = await person("Lee Admin", "admin", "+15555550104");
  const secondOwner = await person("Kai Owner", "owner", "+15555550105");
  const ownerHeaders = await signIn("+15555550101");
  const adminHeaders = await signIn("+15555550103");

  // An admin can't remove, demote, or promote at or above their own rank, even with two owners.
  for (const id of [s.owner.memberId, otherAdmin.memberId, secondOwner.memberId]) {
    refused(await call(removeRoute, adminHeaders, { method: "DELETE", params: { id } }), 403, "NOT_PRIVILEGED");
  }
  refused(await call(addRoute, adminHeaders, { body: { name: "Lee Admin", phone: "+15555550104", role: "member" } }), 403, "NOT_PRIVILEGED");
  refused(await call(addRoute, adminHeaders, { body: { name: "Rae New", phone: "305-555-0160", role: "admin" } }), 403, "NOT_PRIVILEGED");
  refused(await call(addRoute, adminHeaders, { body: { name: "Sam Crew", phone: "+15555550102", role: "admin" } }), 403, "NOT_PRIVILEGED");
  // Nor can one owner remove another.
  refused(await call(removeRoute, ownerHeaders, { method: "DELETE", params: { id: secondOwner.memberId } }), 403, "NOT_PRIVILEGED");
  const active = await db().select().from(members).where(eq(members.status, "active"));
  assert.ok([s.owner.memberId, otherAdmin.memberId, secondOwner.memberId].every((id) => active.some((m) => m.id === id && m.role !== "member")));

  // An admin manages crew; the owner manages admins.
  assert.equal((await call(addRoute, adminHeaders, { body: { name: "Rae New", phone: "305-555-0160" } })).status, 201);
  assert.equal((await call(removeRoute, adminHeaders, { method: "DELETE", params: { id: s.crew.memberId } })).status, 200);
  const demoted = await call(addRoute, ownerHeaders, { body: { name: "Lee Admin", phone: "+15555550104", role: "member" } });
  assert.equal(demoted.status, 201, JSON.stringify(demoted.body));
  assert.equal((await db().select().from(members).where(eq(members.id, otherAdmin.memberId)))[0].role, "member");
  assert.equal((await call(removeRoute, ownerHeaders, { method: "DELETE", params: { id: admin.memberId } })).status, 200);
});

process.env.STRIPE_FAKE = "1";

import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { members, user } from "../../schema/schema";
import { saveCustomer } from "../../core/customers";
import { db } from "../../core/db";
import type { Caller } from "../../core/members";
import { saveItems } from "../../core/pricebook";
import { getProfile } from "../../core/profile";
import { approveQuote, createQuote, type Poster } from "../../core/quotes";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import findCustomerTool from "../../agents/assistant/agent/tools/find_customer";
import saveContactTool from "../../agents/assistant/agent/tools/save_contact";
import saveCustomerTool from "../../agents/assistant/agent/tools/save_customer";
import updateMemberTool from "../../agents/assistant/agent/tools/update_member";
import updateProfileTool from "../../agents/assistant/agent/tools/update_profile";
import { PATCH as accountRoute } from "../../app/api/account/route";
import { PATCH as settingsRoute } from "../../app/api/settings/route";
import { POST as connectRoute } from "../../app/api/stripe/connect/route";
import { POST as disconnectRoute } from "../../app/api/stripe/disconnect/route";
import { POST as addRoute } from "../../app/api/team/route";
import { DELETE as removeRoute, PATCH as memberRoute } from "../../app/api/team/[id]/route";
import { customerFor } from "./customers";
import { appCaller, call, installTransport, person, refused, signIn } from "./test-support";

// Who may do what: crew work with what's theirs, admins run the business, and the owner alone handles
// card payments, the deposit, and who's an admin.

const quiet: Poster = async () => ({ posted: true });
type Out = Record<string, any>;

async function seed() {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const admin = await person("Ada Admin", "admin", "+15555550102");
  const crew = await person("Sam Crew", "member", "+15555550103");
  const otherCrew = await person("Lu Crew", "member", "+15555550104");
  return { owner, admin, crew, otherCrew };
}

const ctx = (caller: Caller) =>
  ({
    session: {
      id: `ses_${caller.memberId}`,
      turn: { id: "turn_1", sequence: 1 },
      auth: { current: { authenticator: "photon-imessage", principalId: `member:${caller.memberId}`, attributes: { orgId: TEST_ORG, memberId: caller.memberId } } },
    },
  }) as never;

withTestDb("roles: only the owner connects Stripe and sets the deposit; admins change the other settings", async () => {
  const s = await seed();
  const ownerHeaders = await signIn("+15555550101");
  const adminHeaders = await signIn("+15555550102");

  refused(await call(connectRoute, adminHeaders, { method: "POST" }), 403, "OWNER_ONLY");
  refused(await call(disconnectRoute, adminHeaders, { method: "POST" }), 403, "OWNER_ONLY");
  const connected = await call(connectRoute, ownerHeaders, { method: "POST" });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  assert.match(String(connected.body?.url), /^http/);

  refused(await call(settingsRoute, adminHeaders, { method: "PATCH", body: { depositPercent: 25 } }), 403, "OWNER_ONLY");
  // The same value as stored isn't a change, so an admin saving the whole Payments form still works.
  const terms = await call(settingsRoute, adminHeaders, { method: "PATCH", body: { paymentTermsDays: 30, depositPercent: 0 } });
  assert.equal(terms.status, 200, JSON.stringify(terms.body));
  assert.deepEqual(terms.body?.changed, ["paymentTermsDays"]);
  const deposit = await call(settingsRoute, ownerHeaders, { method: "PATCH", body: { depositPercent: 25 } });
  assert.equal(deposit.status, 200, JSON.stringify(deposit.body));
  assert.equal((await getProfile(TEST_ORG)).depositPercent, 25);

  // By text too.
  const byAdmin = (await updateProfileTool.execute({ depositPercent: 10 }, ctx(s.admin))) as Out;
  assert.match(String(byAdmin.error), /OWNER_ONLY/);
  assert.equal((await getProfile(TEST_ORG)).depositPercent, 25);
  const adminTerms = (await updateProfileTool.execute({ paymentTermsDays: 15 }, ctx(s.admin))) as Out;
  assert.equal(adminTerms.profile?.paymentTermsDays, 15, JSON.stringify(adminTerms));
  const byOwner = (await updateProfileTool.execute({ depositPercent: 10 }, ctx(s.owner))) as Out;
  assert.equal(byOwner.profile?.depositPercent, 10, JSON.stringify(byOwner));
});

withTestDb("roles: only the owner makes, unmakes, or removes an admin", async () => {
  const s = await seed();
  const ownerHeaders = await signIn("+15555550101");
  const adminHeaders = await signIn("+15555550102");

  // An admin adds crew, but not another admin, by adding or by re-adding a phone with a new role.
  refused(await call(addRoute, adminHeaders, { body: { name: "Rae New", phone: "305-555-0150", role: "admin" } }), 403, "NOT_PRIVILEGED");
  refused(await call(addRoute, adminHeaders, { body: { name: "Sam", phone: "+15555550103", role: "admin" } }), 403, "NOT_PRIVILEGED");
  refused(await call(memberRoute, adminHeaders, { method: "PATCH", params: { id: s.crew.memberId }, body: { role: "admin" } }), 403, "ROLE_OWNER_ONLY");
  const demote = await call(memberRoute, ownerHeaders, { method: "PATCH", params: { id: s.admin.memberId }, body: { name: "Ada", role: "member" } });
  assert.equal(demote.status, 200, JSON.stringify(demote.body));
  const [demoted] = await db().select().from(members).where(eq(members.id, s.admin.memberId));
  assert.equal(demoted.role, "member");
  assert.equal(demoted.name, "Ada");

  const promoted = await call(memberRoute, ownerHeaders, { method: "PATCH", params: { id: s.crew.memberId }, body: { role: "admin" } });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  assert.equal((promoted.body?.member as Out).role, "admin");
  // Sam is an admin now: another admin can't remove or demote him; the owner can.
  const samHeaders = await signIn("+15555550103");
  await call(memberRoute, ownerHeaders, { method: "PATCH", params: { id: s.admin.memberId }, body: { role: "admin" } });
  refused(await call(removeRoute, adminHeaders, { method: "DELETE", params: { id: s.crew.memberId } }), 403, "NOT_PRIVILEGED");
  refused(await call(memberRoute, samHeaders, { method: "PATCH", params: { id: s.admin.memberId }, body: { role: "member" } }), 403);
  assert.equal((await call(removeRoute, ownerHeaders, { method: "DELETE", params: { id: s.crew.memberId } })).status, 200);

  // Nobody changes their own role, and the owner's stays.
  refused(await call(memberRoute, ownerHeaders, { method: "PATCH", params: { id: s.owner.memberId }, body: { role: "admin" } }), 403, "OWN_ROLE");
  const second = await person("Jo Owner", "owner", "+15555550105");
  refused(await call(memberRoute, ownerHeaders, { method: "PATCH", params: { id: second.memberId }, body: { role: "member" } }), 409, "IS_OWNER");

  // By text: the same rules.
  const adminTries = (await updateMemberTool.execute({ memberId: s.otherCrew.memberId, role: "admin" }, ctx({ ...s.admin, role: "admin" }))) as Out;
  assert.match(String(adminTries.error), /ROLE_OWNER_ONLY/);
  const ownerDoes = (await updateMemberTool.execute({ memberId: s.otherCrew.memberId, role: "admin" }, ctx(s.owner))) as Out;
  assert.equal(ownerDoes.member?.role, "admin", JSON.stringify(ownerDoes));
});

withTestDb("roles: names and languages: your own, or for someone below you", async () => {
  const s = await seed();
  const adminHeaders = await signIn("+15555550102");
  const crewHeaders = await signIn("+15555550103");

  // Crew have no Team page, but change themselves on the Account page; their login's name follows.
  refused(await call(memberRoute, crewHeaders, { method: "PATCH", params: { id: s.crew.memberId }, body: { name: "Sammy" } }), 403, "NOT_PRIVILEGED");
  const own = await call(accountRoute, crewHeaders, { method: "PATCH", body: { name: "Sammy", language: "es" } });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  const [crewRow] = await db().select().from(members).where(eq(members.id, s.crew.memberId));
  assert.deepEqual([crewRow.name, crewRow.language], ["Sammy", "es"]);
  assert.ok(crewRow.userId);
  const [login] = await db().select().from(user).where(eq(user.id, crewRow.userId));
  assert.equal(login.name, "Sammy");
  // The Account page can't change a role.
  refused(await call(accountRoute, crewHeaders, { method: "PATCH", body: { role: "admin" } }), 400);

  // An admin changes crew, and themself, but not the owner.
  const renamed = await call(memberRoute, adminHeaders, { method: "PATCH", params: { id: s.otherCrew.memberId }, body: { name: "Lucia", language: "es" } });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  const lucia = renamed.body?.member as Out;
  assert.deepEqual([lucia.name, lucia.language], ["Lucia", "es"]);
  assert.equal((await call(memberRoute, adminHeaders, { method: "PATCH", params: { id: s.admin.memberId }, body: { language: "es" } })).status, 200);
  refused(await call(memberRoute, adminHeaders, { method: "PATCH", params: { id: s.owner.memberId }, body: { name: "Boss" } }), 403, "NOT_PRIVILEGED");

  // By text: "call me …" without an id is the member texting; crew can't rename each other.
  const callMe = (await updateMemberTool.execute({ name: "Sam C." }, ctx(s.crew))) as Out;
  assert.equal(callMe.member?.name, "Sam C.", JSON.stringify(callMe));
  const crewOnCrew = (await updateMemberTool.execute({ memberId: s.otherCrew.memberId, name: "Nope" }, ctx(s.crew))) as Out;
  assert.match(String(crewOnCrew.error), /NOT_PRIVILEGED/);
});

withTestDb("roles: crew add customers and change anyone's, and see every customer in full", async () => {
  const s = await seed();
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], s.owner.memberId);
  const owners = await saveCustomer(TEST_ORG, { name: "Ada Sample", phone: "305-555-0170", address: "1 Sample St" }, s.owner.memberId);
  const quoted = await saveCustomer(TEST_ORG, { name: "Bo Sample", email: "bo@example.test" }, s.owner.memberId);
  const crewQuote = await createQuote({ title: "2 Sample St", customerId: quoted.id, lines: [{ itemId: item.id, quantity: 1 }] }, s.crew, { post: quiet });
  await approveQuote(crewQuote.quoteId, s.owner, { post: quiet });

  // A new customer is anyone's to add.
  const added = (await saveCustomerTool.execute({ name: "Cy Sample", phone: "305-555-0171" }, ctx(s.crew))) as Out;
  assert.ok(added.customer?.id, JSON.stringify(added));
  const fixed = (await saveCustomerTool.execute({ customerId: added.customer.id, notes: "Prefers mornings" }, ctx(s.crew))) as Out;
  assert.equal(fixed.customer?.notes, "Prefers mornings", JSON.stringify(fixed));
  // On their quote.
  const onQuote = (await saveContactTool.execute({ customerId: quoted.id, name: "Tenant Sample", addPhones: ["305-555-0172"] }, ctx(s.crew))) as Out;
  assert.ok(onQuote.contact, JSON.stringify(onQuote));

  // Anyone else's too, by customer and by contact: another crew member's, or one only the owner has worked with.
  const notTheirs = (await saveCustomerTool.execute({ customerId: owners.id, notes: "changed" }, ctx(s.crew))) as Out;
  assert.equal(notTheirs.customer?.notes, "changed", JSON.stringify(notTheirs));
  const contact = (await saveContactTool.execute({ customerId: owners.id, name: "Someone" }, ctx(s.crew))) as Out;
  assert.ok(contact.contact, JSON.stringify(contact));
  const otherCrews = (await saveCustomerTool.execute({ customerId: added.customer.id, notes: "mine now" }, ctx(s.otherCrew))) as Out;
  assert.equal(otherCrews.customer?.notes, "mine now", JSON.stringify(otherCrews));
  const byAdmin = (await saveCustomerTool.execute({ customerId: owners.id, notes: "from the office" }, ctx(s.admin))) as Out;
  assert.equal(byAdmin.customer?.notes, "from the office", JSON.stringify(byAdmin));

  // Finding: crew see every customer in full, so they can reach them and don't add one twice.
  const found = (await findCustomerTool.execute({ query: "Sample" }, ctx(s.crew))) as Out;
  const byName = Object.fromEntries((found.customers as Out[]).map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(byName).sort(), ["Ada Sample", "Bo Sample", "Cy Sample"]);
  assert.ok(byName["Ada Sample"].contacts.length > 0, "someone else's customer comes with contacts too");
  assert.deepEqual(byName["Ada Sample"].properties.map((p: Out) => p.address), ["1 Sample St"]);
});

withTestDb("roles: crew draft for a repeat customer they found by name, and can change and open that customer at once", async () => {
  const s = await seed();
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], s.owner.memberId);
  const ada = await saveCustomer(TEST_ORG, { name: "Ada Sample", phone: "305-555-0170", address: "1 Sample St" }, s.owner.memberId);
  const crewHeaders = await signIn("+15555550103");

  const [hit] = ((await findCustomerTool.execute({ query: "Ada" }, ctx(s.crew))) as Out).customers as Out[];
  assert.ok(hit.contacts.length > 0);
  const draft = await createQuote({ title: "1 Sample St", customerId: hit.id, lines: [{ itemId: item.id, quantity: 1 }] }, s.crew, { post: quiet });
  assert.notEqual(draft.status, "approved");

  // No approval needed first: the customer is the team's.
  const contact = (await saveContactTool.execute({ customerId: ada.id, name: "Tenant Sample", addPhones: ["305-555-0199"] }, ctx(s.crew))) as Out;
  assert.ok(contact.contact, JSON.stringify(contact));
  const edit = (await saveCustomerTool.execute({ customerId: ada.id, notes: "changed" }, ctx(s.crew))) as Out;
  assert.equal(edit.customer?.notes, "changed", JSON.stringify(edit));
  assert.equal((await customerFor(await appCaller(crewHeaders), ada.id)).customer.id, ada.id);
});

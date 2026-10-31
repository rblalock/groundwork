import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { customers as customersTable, properties } from "../../schema/schema";
import { saveCustomer } from "../../core/customers";
import { db } from "../../core/db";
import { saveItems } from "../../core/pricebook";
import { approveQuote, createQuote, type Poster } from "../../core/quotes";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { PATCH as customerRoute } from "../../app/api/customers/[id]/route";
import { POST as newCustomerRoute, GET as searchRoute } from "../../app/api/customers/route";
import { POST as contactsRoute } from "../../app/api/customers/[id]/contacts/route";
import { DELETE as contactDeleteRoute, PATCH as contactPatchRoute } from "../../app/api/customers/[id]/contacts/[contactId]/route";
import { POST as archiveRoute } from "../../app/api/customers/[id]/archive/route";
import { POST as mergeRoute } from "../../app/api/customers/[id]/merge/route";
import { customerFor, customersFor } from "./customers";
import { appCaller, call, installTransport, otherBusiness, person, refused, signIn, superAdminViewing } from "./test-support";

const quiet: Poster = async () => ({ posted: true });

async function seed() {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const crew = await person("Sam Crew", "member", "+15555550102");
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.memberId);
  const theirs = await saveCustomer(TEST_ORG, { name: "Ada Sample", phone: "305-555-0170", address: "1 Sample St" }, owner.memberId);
  const onCrewQuote = await saveCustomer(TEST_ORG, { name: "Bo Sample", email: "bo@example.test" }, owner.memberId);
  const noQuotes = await saveCustomer(TEST_ORG, { name: "Cy Sample" }, owner.memberId);
  await createQuote({ title: "1 Sample St", customerId: theirs.id, lines: [{ itemId: item.id, quantity: 2 }] }, owner, { post: quiet });
  await createQuote({ title: "1 Sample St again", customerId: theirs.id, lines: [{ itemId: item.id, quantity: 3 }] }, owner, { post: quiet });
  const crewQuote = await createQuote({ title: "2 Sample St", customerId: onCrewQuote.id, lines: [{ itemId: item.id, quantity: 1 }] }, crew, { post: quiet });
  await approveQuote(crewQuote.quoteId, owner, { post: quiet });

  const other = await otherBusiness();
  const otherOwner = await person("Kim Other", "owner", "+15555550201", other);
  const otherCustomer = await saveCustomer(other, { name: "Ada Elsewhere" }, otherOwner.memberId);
  return { theirs, onCrewQuote, noQuotes, otherCustomer };
}

withTestDb("customers: everyone on the team sees every customer and their quotes, with quote counts", async () => {
  const s = await seed();
  const crew = await appCaller(await signIn("+15555550102"));
  const owner = await appCaller(await signIn("+15555550101"));

  const crewList = await customersFor(crew);
  assert.deepEqual(crewList.map((c) => [c.name, c.quoteCount]).sort(), [["Ada Sample", 2], ["Bo Sample", 1], ["Cy Sample", 0]]);
  assert.deepEqual((await customerFor(crew, s.theirs.id)).quotes.map((q) => q.title).sort(), ["1 Sample St", "1 Sample St again"]);
  assert.deepEqual((await customerFor(crew, s.noQuotes.id)).quotes, []);
  const page = await customerFor(crew, s.onCrewQuote.id);
  assert.deepEqual(page.quotes.map((q) => q.title), ["2 Sample St"]);
  await assert.rejects(customerFor(crew, s.otherCustomer.id), { status: 404 });

  const all = await customersFor(owner);
  assert.deepEqual(all.map((c) => c.name).sort(), ["Ada Sample", "Bo Sample", "Cy Sample"]);
  assert.equal(all.find((c) => c.name === "Ada Sample")?.quoteCount, 2);
  assert.deepEqual((await customersFor(owner, "ada")).map((c) => c.name), ["Ada Sample"]);
  assert.deepEqual((await customersFor(owner, "555-0170")).map((c) => c.name), ["Ada Sample"]);
  assert.deepEqual((await customersFor(owner, "1 sample st")).map((c) => c.name), ["Ada Sample"]);
  await assert.rejects(customerFor(owner, s.otherCustomer.id), { status: 404 });
});

withTestDb("customers: anyone on the team edits contacts and adds an address; other businesses and super admins can't", async () => {
  const s = await seed();
  const crewHeaders = await signIn("+15555550102");
  const ownerHeaders = await signIn("+15555550101");

  refused(await call(customerRoute, crewHeaders, { method: "PATCH", params: { id: s.onCrewQuote.id }, body: { notes: "from the crew" } }), 200);
  refused(await call(customerRoute, ownerHeaders, { method: "PATCH", params: { id: s.otherCustomer.id }, body: { notes: "x" } }), 404);
  refused(await call(customerRoute, ownerHeaders, { method: "PATCH", params: { id: s.theirs.id }, body: { phone: "12" } }), 400, "INVALID_PHONE");
  refused(await call(customerRoute, ownerHeaders, { method: "PATCH", params: { id: s.theirs.id }, body: { orgId: "org_other" } }), 400, "INVALID_INPUT");

  const saved = await call(customerRoute, ownerHeaders, {
    method: "PATCH",
    params: { id: s.theirs.id },
    body: { name: "Ada Q. Sample", phone: "(305) 555-0171", email: "", language: "es", notes: "Gate code on file", address: "5 Example Ave" },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const [row] = await db().select().from(customersTable).where(eq(customersTable.id, s.theirs.id));
  assert.equal(row.name, "Ada Q. Sample");
  assert.deepEqual(row.phones, ["+13055550170", "+13055550171"]);
  assert.equal(row.language, "es");
  assert.equal(row.notes, "Gate code on file");
  const addresses = await db().select().from(properties).where(eq(properties.customerId, s.theirs.id));
  assert.deepEqual(addresses.map((p) => p.address).sort(), ["1 Sample St", "5 Example Ave"]);

  const admin = await superAdminViewing(TEST_ORG);
  assert.equal((await customersFor(await appCaller(admin))).length, 3);
  refused(await call(customerRoute, admin, { method: "PATCH", params: { id: s.theirs.id }, body: { notes: "y" } }), 403, "NOT_A_MEMBER");
});

withTestDb("customers: owners manage contacts, archive, and merge from the page, from the revision they saw", async () => {
  const s = await seed();
  const crewHeaders = await signIn("+15555550102");
  const ownerHeaders = await signIn("+15555550101");
  const id = s.theirs.id;
  const revisionOf = async (customerId: string) => (await db().select().from(customersTable).where(eq(customersTable.id, customerId)))[0].revision;

  // A change made on a stale page is refused and changes nothing.
  const start = await revisionOf(id);
  refused(await call(customerRoute, ownerHeaders, { method: "PATCH", params: { id }, body: { notes: "first", expectedRevision: start } }), 200);
  refused(await call(customerRoute, ownerHeaders, { method: "PATCH", params: { id }, body: { notes: "stale", expectedRevision: start } }), 409, "REVISION_CHANGED");
  assert.equal((await db().select().from(customersTable).where(eq(customersTable.id, id)))[0].notes, "first");

  // Contacts: crew add one too; owners add one, change it, and remove it.
  refused(
    await call(contactsRoute, crewHeaders, { method: "POST", params: { id: s.onCrewQuote.id }, body: { name: "Sam's Contact", expectedRevision: await revisionOf(s.onCrewQuote.id) } }),
    200,
  );
  const added = await call(contactsRoute, ownerHeaders, {
    method: "POST",
    params: { id },
    body: { name: "Bo Tenant", role: "tenant", addPhones: ["305 555 0172"], expectedRevision: await revisionOf(id) },
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const tenant = (added.body?.customer as { contacts: Array<{ id: string; name: string }> }).contacts.find((c) => c.name === "Bo Tenant")!;
  refused(
    await call(contactPatchRoute, ownerHeaders, { method: "PATCH", params: { id: s.otherCustomer.id, contactId: tenant.id }, body: { preferred: true, expectedRevision: 1 } }),
    404,
  );
  const preferred = await call(contactPatchRoute, ownerHeaders, {
    method: "PATCH",
    params: { id, contactId: tenant.id },
    body: { preferred: true, expectedRevision: await revisionOf(id) },
  });
  assert.equal((preferred.body?.customer as { contacts: Array<{ name: string }> }).contacts[0].name, "Bo Tenant");
  refused(await call(contactDeleteRoute, ownerHeaders, { method: "DELETE", params: { id, contactId: tenant.id }, body: { expectedRevision: await revisionOf(id) } }), 200);

  // Search for a duplicate, then merge it in; a stale revision of either side is refused.
  refused(await call(searchRoute, crewHeaders, {}), 403, "NOT_PRIVILEGED");
  const dupe = await saveCustomer(TEST_ORG, { name: "A. Sample", phone: "+13055550173" }, (await appCaller(ownerHeaders)).memberId!);
  const search = await searchRoute(new Request(`http://localhost:3000/api/customers?q=sample&exclude=${id}`, { headers: ownerHeaders }));
  const candidates = ((await search.json()) as { customers: Array<{ id: string }> }).customers.map((c) => c.id);
  assert.ok(candidates.includes(dupe.id) && !candidates.includes(id) && !candidates.includes(s.otherCustomer.id));
  refused(
    await call(mergeRoute, ownerHeaders, { method: "POST", params: { id }, body: { otherId: dupe.id, expectedRevision: await revisionOf(id), otherRevision: 99 } }),
    409,
    "REVISION_CHANGED",
  );
  refused(
    await call(mergeRoute, ownerHeaders, { method: "POST", params: { id }, body: { otherId: s.otherCustomer.id, expectedRevision: await revisionOf(id), otherRevision: 1 } }),
    404,
  );
  const merged = await call(mergeRoute, ownerHeaders, {
    method: "POST",
    params: { id },
    body: { otherId: dupe.id, expectedRevision: await revisionOf(id), otherRevision: await revisionOf(dupe.id) },
  });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.ok((await customersFor(await appCaller(ownerHeaders))).every((c) => c.id !== dupe.id));

  // Archive: off the list, and back.
  refused(await call(archiveRoute, crewHeaders, { method: "POST", params: { id: s.onCrewQuote.id }, body: { archived: true, expectedRevision: 1 } }), 403);
  refused(await call(archiveRoute, ownerHeaders, { method: "POST", params: { id }, body: { archived: true, expectedRevision: await revisionOf(id) } }), 200);
  assert.ok((await customersFor(await appCaller(ownerHeaders))).every((c) => c.id !== id));
  assert.ok((await customerFor(await appCaller(ownerHeaders), id)).customer.archivedAt, "an archived customer's page still opens");
  refused(await call(archiveRoute, ownerHeaders, { method: "POST", params: { id }, body: { archived: false, expectedRevision: await revisionOf(id) } }), 200);
  assert.ok((await customersFor(await appCaller(ownerHeaders))).some((c) => c.id === id));
  const history = (await customerFor(await appCaller(ownerHeaders), id)).history.map((h) => h.kind);
  assert.deepEqual(history.slice(0, 3), ["customer.restored", "customer.archived", "customer.merged"]);
  assert.deepEqual((await customerFor(await appCaller(crewHeaders), s.onCrewQuote.id)).history, [], "crew see no history");
});

withTestDb("customers: anyone on the team adds a customer from the page, as the assistant saves one", async () => {
  await seed();
  const crewHeaders = await signIn("+15555550102");
  refused(await call(newCustomerRoute, crewHeaders, { body: { name: "  " } }), 400);
  refused(await call(newCustomerRoute, crewHeaders, { body: { name: "Dee Sample", phone: "555" } }), 400, "INVALID_PHONE");

  const saved = await call(newCustomerRoute, crewHeaders, {
    body: { name: "Dee Sample", phone: "(305) 555-0177", email: "dee@example.com", address: "4 Sample St", language: "es" },
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const id = (saved.body?.customer as { id: string }).id;
  const page = await customerFor(await appCaller(crewHeaders), id);
  assert.deepEqual(
    [page.customer.language, page.customer.contacts.map((c) => [c.name, c.phones, c.emails, c.preferred]), page.customer.properties.map((p) => p.address)],
    ["es", [["Dee Sample", ["+13055550177"], ["dee@example.com"], true]], ["4 Sample St"]],
  );
  refused(await call(newCustomerRoute, await superAdminViewing(TEST_ORG), { body: { name: "Eve Sample" } }), 403);
});

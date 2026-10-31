import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { conversations, customerContacts, customers, invoices, notes, properties, quotes, serviceJobs } from "../schema/schema";
import {
  archiveCustomer,
  customerCursor,
  customerHistory,
  getCustomer,
  likelySameCustomers,
  listCustomers,
  mergeCustomers,
  removeContact,
  removeProperty,
  restoreCustomer,
  saveContact,
  saveCustomer,
  saveProperty,
  searchCustomers,
} from "./customers";
import { db } from "./db";
import { createInvoice } from "./invoices";
import { createMember, type Caller } from "./members";
import { saveNote } from "./notes";
import { saveItems } from "./pricebook";
import { approveQuote, createQuote, getQuote, type Poster } from "./quotes";
import { bookVisit } from "./scheduling";
import { TEST_ORG, withTestDb } from "./test-db";

const quiet: Poster = async () => ({ posted: true });
const NOW = new Date("2026-10-20T16:00:00Z");

async function owner(): Promise<Caller> {
  const m = await createMember({ orgId: TEST_ORG, name: "Pat Owner", role: "owner" });
  return { orgId: TEST_ORG, memberId: m.id, name: m.name, role: "owner", language: "en", phoneE164: null };
}

withTestDb("contacts: a customer's phone and email land on a preferred contact; more people are added and changed", async () => {
  const o = await owner();
  const jane = await saveCustomer(TEST_ORG, { name: "Jane Sample", phone: "305 555 0101", email: "Jane@Example.test" }, o.memberId);
  assert.equal(jane.revision, 1);
  assert.deepEqual(
    jane.contacts.map((c) => [c.name, c.phones, c.emails, c.preferred]),
    [["Jane Sample", ["+13055550101"], ["jane@example.test"], true]],
  );
  assert.deepEqual([jane.phones, jane.emails], [["+13055550101"], ["jane@example.test"]]);

  const { contact: tenant, customer: withTenant } = await saveContact(
    TEST_ORG,
    { customerId: jane.id, name: "Bo Tenant", role: "tenant", addPhones: ["(305) 555-0102"] },
    o.memberId,
  );
  assert.equal(tenant.preferred, false);
  assert.equal(withTenant.revision, 2);
  assert.deepEqual(withTenant.phones, ["+13055550101", "+13055550102"], "the mirror lists the preferred contact first");
  assert.equal((await searchCustomers(TEST_ORG, "tenant"))[0]?.id, jane.id, "a contact's role finds the customer");
  assert.equal((await searchCustomers(TEST_ORG, "bo tenant"))[0]?.id, jane.id);
  assert.equal((await searchCustomers(TEST_ORG, "555-0102"))[0]?.id, jane.id, "any contact's phone finds the customer");

  // The tenant becomes the preferred contact, gets a new number in place of the old one, and an email.
  const { customer: changed } = await saveContact(
    TEST_ORG,
    { customerId: jane.id, contactId: tenant.id, preferred: true, addPhones: ["305 555 0103"], removePhones: ["305-555-0102"], addEmails: ["bo@example.test"] },
    o.memberId,
  );
  assert.deepEqual(
    changed.contacts.map((c) => [c.name, c.preferred, c.phones]),
    [
      ["Bo Tenant", true, ["+13055550103"]],
      ["Jane Sample", false, ["+13055550101"]],
    ],
  );
  assert.deepEqual(changed.emails, ["bo@example.test", "jane@example.test"]);
  await assert.rejects(saveContact(TEST_ORG, { customerId: jane.id, addPhones: ["+13055550199"] }, o.memberId), /CONTACT_NAME_REQUIRED/);
  await assert.rejects(saveContact(TEST_ORG, { customerId: jane.id, name: "X", addPhones: ["12"] }, o.memberId), /INVALID_PHONE/);
  await assert.rejects(saveContact(TEST_ORG, { customerId: jane.id, name: "X", addEmails: ["nope"] }, o.memberId), /INVALID_EMAIL/);

  // Removing the preferred contact makes the next one preferred; the mirror follows.
  const after = await removeContact(TEST_ORG, { customerId: jane.id, contactId: tenant.id }, o.memberId);
  assert.deepEqual(after.contacts.map((c) => [c.name, c.preferred]), [["Jane Sample", true]]);
  assert.deepEqual([after.phones, after.emails], [["+13055550101"], ["jane@example.test"]]);
});

withTestDb("history records who changed what, oldest to newest, with before and after", async () => {
  const o = await owner();
  const admin = await createMember({ orgId: TEST_ORG, name: "Ann Admin", role: "admin" });
  const c = await saveCustomer(TEST_ORG, { name: "Jo Sample", address: "1 Sample St" }, o.memberId);
  await saveCustomer(TEST_ORG, { customerId: c.id, name: "Jo Q. Sample", phone: "+13055550111" }, admin.id);
  await saveCustomer(TEST_ORG, { customerId: c.id, address: "1 sample st." }, admin.id); // same address: no change
  const history = await customerHistory(TEST_ORG, c.id);
  assert.deepEqual(
    history.map((h) => [h.kind, h.memberName]).reverse(),
    [
      ["customer.created", "Pat Owner"],
      ["property.added", "Pat Owner"],
      ["customer.updated", "Ann Admin"],
      ["contact.added", "Ann Admin"],
    ],
  );
  const renamed = history.find((h) => h.kind === "customer.updated")!;
  assert.equal(renamed.before?.name, "Jo Sample");
  assert.equal(renamed.after?.name, "Jo Q. Sample");
  assert.equal((await getCustomer(TEST_ORG, c.id))?.revision, 2, "a save that changes nothing doesn't move the revision");
});

withTestDb("an edit made from an older read is refused, and changes nothing", async () => {
  const o = await owner();
  const c = await saveCustomer(TEST_ORG, { name: "Kim Sample" }, o.memberId);
  // Someone else changes it first.
  await saveCustomer(TEST_ORG, { customerId: c.id, notes: "Prefers mornings" }, o.memberId, { expectedRevision: 1 });
  await assert.rejects(saveCustomer(TEST_ORG, { customerId: c.id, name: "Kimberly Sample" }, o.memberId, { expectedRevision: 1 }), /REVISION_CHANGED/);
  await assert.rejects(saveContact(TEST_ORG, { customerId: c.id, name: "X" }, o.memberId, { expectedRevision: 1 }), /REVISION_CHANGED/);
  await assert.rejects(archiveCustomer(TEST_ORG, c.id, o.memberId, { expectedRevision: 1 }), /REVISION_CHANGED/);
  const now = await getCustomer(TEST_ORG, c.id);
  assert.equal(now?.name, "Kim Sample");
  assert.equal(now?.revision, 2);
  assert.equal(now?.contacts.length, 0);
  await saveCustomer(TEST_ORG, { customerId: c.id, name: "Kimberly Sample" }, o.memberId, { expectedRevision: 2 });
  assert.equal((await getCustomer(TEST_ORG, c.id))?.name, "Kimberly Sample");
});

withTestDb("properties: an address is corrected and placed again, notes alone leave the place, and history keeps both", async () => {
  const o = await owner();
  const maria = await saveCustomer(TEST_ORG, { name: "Maria Sample", address: "412 Oak St" }, o.memberId);
  const oak = maria.properties[0];
  assert.equal(oak.geocodeStatus, "ok");

  const noted = await saveProperty(TEST_ORG, { customerId: maria.id, propertyId: oak.id, notes: "Side gate" }, o.memberId, { expectedRevision: maria.revision });
  assert.deepEqual([noted.properties[0].notes, noted.properties[0].lat, noted.properties[0].placeLabel], ["Side gate", 26.9617, "412 Oak St, Tequesta, FL 33469"]);
  assert.equal(noted.revision, maria.revision + 1);

  const moved = await saveProperty(TEST_ORG, { customerId: maria.id, propertyId: oak.id, address: "7 Pine Ave" }, o.memberId, { expectedRevision: noted.revision });
  assert.deepEqual(
    [moved.properties[0].address, moved.properties[0].notes, moved.properties[0].lat, moved.properties[0].placeLabel],
    ["7 Pine Ave", "Side gate", 26.9452, "7 Pine Ave, Tequesta, FL 33469"],
  );
  const lost = await saveProperty(TEST_ORG, { customerId: maria.id, propertyId: oak.id, address: "999 Nowhere Ln" }, o.memberId);
  assert.deepEqual([lost.properties[0].geocodeStatus, lost.properties[0].lat, lost.properties[0].placeLabel], ["not_found", null, null], "never the old place");

  const same = await saveProperty(TEST_ORG, { customerId: maria.id, propertyId: oak.id, address: "999 Nowhere Ln" }, o.memberId);
  assert.equal(same.revision, lost.revision, "nothing changed, nothing recorded");
  await assert.rejects(saveProperty(TEST_ORG, { customerId: maria.id, propertyId: oak.id, notes: "x" }, o.memberId, { expectedRevision: 1 }), /REVISION_CHANGED/);
  const other = await saveCustomer(TEST_ORG, { name: "Other Sample", address: "4 Elm Rd" }, o.memberId);
  await assert.rejects(saveProperty(TEST_ORG, { customerId: maria.id, propertyId: other.properties[0].id, address: "x" }, o.memberId), /PROPERTY_NOT_FOUND/);
  await assert.rejects(removeProperty(TEST_ORG, { customerId: maria.id, propertyId: other.properties[0].id }, o.memberId), /PROPERTY_NOT_FOUND/);

  // The assistant's way: an address with the property it corrects.
  const fixed = await saveCustomer(TEST_ORG, { customerId: maria.id, propertyId: oak.id, address: "412 Oak St" }, o.memberId);
  assert.deepEqual([fixed.properties.length, fixed.properties[0].address, fixed.properties[0].lat], [1, "412 Oak St", 26.9617]);

  await assert.rejects(removeProperty(TEST_ORG, { customerId: maria.id, propertyId: oak.id }, o.memberId, { expectedRevision: maria.revision }), /REVISION_CHANGED/);
  const gone = await removeProperty(TEST_ORG, { customerId: maria.id, propertyId: oak.id }, o.memberId, { expectedRevision: fixed.revision });
  assert.deepEqual(gone.properties, [], "the last address too: it's their choice");
  assert.deepEqual(
    (await customerHistory(TEST_ORG, maria.id)).slice(0, 5).map((h) => [h.kind, h.before?.address ?? null, h.after?.address ?? null]),
    [
      ["property.removed", "412 Oak St", null],
      ["property.changed", "999 Nowhere Ln", "412 Oak St"],
      ["property.changed", "7 Pine Ave", "999 Nowhere Ln"],
      ["property.changed", "412 Oak St", "7 Pine Ave"],
      ["property.changed", "412 Oak St", "412 Oak St"],
    ],
  );
});

withTestDb("a property a quote is on can't be removed, and says how many records use it", async () => {
  const o = await owner();
  const [item] = await saveItems(TEST_ORG, [{ name: "Widget service", unitKind: "each", unitLabel: "widget", priceCents: 1000 }], o.memberId);
  const c = await saveCustomer(TEST_ORG, { name: "Ray Sample", address: "12 Oak St" }, o.memberId);
  const prop = c.properties[0];
  await createQuote({ title: "12 Oak St", customerId: c.id, propertyId: prop.id, lines: [{ itemId: item.id, quantity: 1 }] }, o, { post: quiet, now: NOW });
  await saveNote(o, { title: "Gate code", body: "Gate code 4821", propertyId: prop.id });
  const now = (await getCustomer(TEST_ORG, c.id))!;
  await assert.rejects(removeProperty(TEST_ORG, { customerId: c.id, propertyId: prop.id }, o.memberId, { expectedRevision: now.revision }), /^Error: PROPERTY_IN_USE:2$/);
  const after = (await getCustomer(TEST_ORG, c.id))!;
  assert.deepEqual([after.properties.length, after.revision], [1, now.revision], "nothing changed");
});

withTestDb("archive takes a customer off lists and search, keeps their quotes and invoices, and can be undone", async () => {
  const o = await owner();
  const [item] = await saveItems(TEST_ORG, [{ name: "Widget service", unitKind: "each", unitLabel: "widget", priceCents: 1000 }], o.memberId);
  const c = await saveCustomer(TEST_ORG, { name: "Lee Sample", phone: "+13055550120", address: "9 Sample Rd" }, o.memberId);
  const quote = await createQuote({ title: "9 Sample Rd", customerId: c.id, lines: [{ itemId: item.id, quantity: 3 }] }, o, { post: quiet, now: NOW });
  await approveQuote(quote.quoteId, o, { post: quiet, now: NOW });
  const { invoice } = await createInvoice(o, { quoteId: quote.quoteId }, { now: NOW, post: quiet });

  const { kept } = await archiveCustomer(TEST_ORG, c.id, o.memberId);
  assert.deepEqual([kept.quotes, kept.invoices], [1, 1]);
  assert.deepEqual(await searchCustomers(TEST_ORG, "Lee"), []);
  assert.deepEqual(await listCustomers(TEST_ORG), []);
  assert.equal((await searchCustomers(TEST_ORG, "Lee", { includeArchived: true }))[0]?.id, c.id);
  // The records stay, still theirs.
  assert.equal((await getQuote(TEST_ORG, quote.quoteId))?.customer?.id, c.id);
  const [row] = await db().select().from(invoices).where(eq(invoices.id, invoice.id));
  assert.equal(row.customerId, c.id);
  assert.ok((await getCustomer(TEST_ORG, c.id))?.archivedAt);
  await assert.rejects(saveCustomer(TEST_ORG, { customerId: c.id, notes: "x" }, o.memberId), /CUSTOMER_ARCHIVED/);
  await assert.rejects(archiveCustomer(TEST_ORG, c.id, o.memberId), /CUSTOMER_ARCHIVED/);

  await restoreCustomer(TEST_ORG, c.id, o.memberId);
  assert.equal((await listCustomers(TEST_ORG))[0]?.id, c.id);
  assert.deepEqual(
    (await customerHistory(TEST_ORG, c.id)).slice(0, 2).map((h) => h.kind),
    ["customer.restored", "customer.archived"],
  );
});

withTestDb("merge moves quotes, properties, invoices, work, notes, and contacts to the kept customer", async () => {
  const o = await owner();
  const crew = await createMember({ orgId: TEST_ORG, name: "Sam Crew", role: "member" });
  const [item] = await saveItems(TEST_ORG, [{ name: "Widget service", unitKind: "each", unitLabel: "widget", priceCents: 1000 }], o.memberId);
  const jane = await saveCustomer(TEST_ORG, { name: "Jane Smith", phone: "+13055550130", address: "12 Oak St", notes: "Gate sticks" }, o.memberId);
  const j = await saveCustomer(TEST_ORG, { name: "J. Smith", phone: "+13055550131", email: "js@example.test", address: "12 Oak St.", notes: "Dog in yard" }, o.memberId);
  await saveCustomer(TEST_ORG, { customerId: j.id, address: "40 Pine Ave" }, o.memberId);
  const { contact: tenant } = await saveContact(TEST_ORG, { customerId: j.id, name: "Bo Tenant", role: "tenant", addPhones: ["+13055550132"] }, o.memberId);
  const jFull = (await getCustomer(TEST_ORG, j.id))!;
  const oakDup = jFull.properties.find((p) => p.address === "12 Oak St.")!;
  const pine = jFull.properties.find((p) => p.address === "40 Pine Ave")!;

  const quote = await createQuote(
    { title: "12 Oak St", customerId: j.id, propertyId: oakDup.id, lines: [{ itemId: item.id, quantity: 2 }] },
    o,
    { post: quiet, now: NOW },
  );
  await approveQuote(quote.quoteId, o, { post: quiet, now: NOW });
  const booked = await bookVisit(o, { quoteId: quote.quoteId, memberIds: [crew.id], day: "2026-10-27", time: "09:00" }, { now: NOW, post: quiet });
  const { invoice } = await createInvoice(o, { quoteId: quote.quoteId }, { now: NOW, post: quiet });
  const note = await saveNote(o, { title: "Gate code", body: "Gate code 4821", propertyId: oakDup.id });
  await db().insert(conversations).values({ id: "conv_job", orgId: TEST_ORG, memberId: o.memberId, kind: "job", customerId: j.id, title: "J. Smith" });

  const result = await mergeCustomers(TEST_ORG, { keepId: jane.id, mergeId: j.id }, o.memberId);
  assert.deepEqual(result.moved, { quotes: 1, invoices: 1, serviceJobs: 1, notes: 1, conversations: 1, properties: 2, contacts: 1 });

  const kept = result.customer;
  // 12 Oak St. folded into Jane's 12 Oak St; Pine Ave moved over.
  assert.deepEqual(kept.properties.map((p) => p.address), ["12 Oak St", "40 Pine Ave"]);
  const oak = kept.properties[0];
  const [q] = await db().select().from(quotes).where(eq(quotes.id, quote.quoteId));
  assert.deepEqual([q.customerId, q.propertyId], [jane.id, oak.id]);
  const [inv] = await db().select().from(invoices).where(eq(invoices.id, invoice.id));
  assert.equal(inv.customerId, jane.id);
  const [job] = await db().select().from(serviceJobs).where(eq(serviceJobs.id, booked.visit.jobId));
  assert.deepEqual([job.customerId, job.propertyId], [jane.id, oak.id]);
  const [n] = await db().select().from(notes).where(eq(notes.id, note.id));
  assert.deepEqual([n.customerId, n.propertyId], [jane.id, oak.id]);
  const [conv] = await db().select().from(conversations).where(eq(conversations.id, "conv_job"));
  assert.equal(conv.customerId, jane.id);
  assert.equal(await db().$count(properties, eq(properties.id, oakDup.id)), 0);
  assert.equal((await db().select().from(properties).where(eq(properties.id, pine.id)))[0].customerId, jane.id);

  // J. Smith's own contact folded into Jane's; the tenant moved over, not preferred.
  assert.deepEqual(
    kept.contacts.map((c) => [c.name, c.role, c.phones, c.emails, c.preferred]),
    [
      ["Jane Smith", null, ["+13055550130", "+13055550131"], ["js@example.test"], true],
      ["Bo Tenant", "tenant", ["+13055550132"], [], false],
    ],
  );
  assert.equal(kept.contacts[1].id, tenant.id);
  assert.deepEqual(kept.phones, ["+13055550130", "+13055550131", "+13055550132"]);
  assert.equal(kept.notes, "Gate sticks\n\nDog in yard");

  const gone = (await getCustomer(TEST_ORG, j.id))!;
  assert.equal(gone.mergedIntoId, jane.id);
  assert.ok(gone.archivedAt);
  assert.deepEqual([gone.contacts, gone.properties, gone.phones], [[], [], []]);
  assert.deepEqual((await searchCustomers(TEST_ORG, "smith")).map((c) => c.id), [jane.id]);
  assert.equal((await customerHistory(TEST_ORG, jane.id))[0].kind, "customer.merged");
  assert.equal((await customerHistory(TEST_ORG, j.id))[0].kind, "customer.merged_into");
  await assert.rejects(restoreCustomer(TEST_ORG, j.id, o.memberId), /CUSTOMER_MERGED/);
  await assert.rejects(mergeCustomers(TEST_ORG, { keepId: jane.id, mergeId: j.id }, o.memberId), /CUSTOMER_ARCHIVED/);
  await assert.rejects(mergeCustomers(TEST_ORG, { keepId: jane.id, mergeId: jane.id }, o.memberId), /SAME_CUSTOMER/);
});

withTestDb("a merge that fails part way changes nothing", async () => {
  const o = await owner();
  const a = await saveCustomer(TEST_ORG, { name: "Al Sample", phone: "+13055550140", address: "5 Elm St" }, o.memberId);
  const b = await saveCustomer(TEST_ORG, { name: "Al Sample Jr", phone: "+13055550141", address: "6 Elm St" }, o.memberId);
  await saveContact(TEST_ORG, { customerId: b.id, name: "Cy Tenant", role: "tenant" }, o.memberId);
  const snapshot = async () =>
    JSON.stringify(
      await db().execute(sql`
        select (select json_agg(c order by c.id) from customers c) as customers,
               (select json_agg(p order by p.id) from properties p) as properties,
               (select json_agg(cc order by cc.id) from customer_contacts cc) as contacts,
               (select count(*) from customer_changes) as changes`),
    );
  const before = await snapshot();
  // A stale revision for the kept customer is only found after the merged one is locked: the lock and
  // the check are inside the transaction, so it rolls back whole.
  await assert.rejects(
    mergeCustomers(TEST_ORG, { keepId: a.id, mergeId: b.id }, o.memberId, { expectedRevisions: { keep: 99 } }),
    /REVISION_CHANGED/,
  );
  // A database failure part way through (the merged customer's contacts can't be moved) rolls back too.
  await db().execute(sql`create or replace function fail_contact_move() returns trigger language plpgsql as $$
    begin if new.customer_id <> old.customer_id then raise exception 'boom'; end if; return new; end $$`);
  await db().execute(sql`create trigger fail_contact_move before update on customer_contacts for each row execute function fail_contact_move()`);
  try {
    // The tenant moves (it doesn't fold), so the trigger fires after the properties moved.
    await assert.rejects(mergeCustomers(TEST_ORG, { keepId: a.id, mergeId: b.id }, o.memberId), (error: Error) => /boom/.test(String(error.cause)));
  } finally {
    await db().execute(sql`drop trigger fail_contact_move on customer_contacts`);
    await db().execute(sql`drop function fail_contact_move()`);
  }
  assert.equal(await snapshot(), before);
  assert.equal((await getCustomer(TEST_ORG, b.id))?.archivedAt, null);
});

withTestDb("a phone or email written straight to a customer is filed under a contact", async () => {
  const o = await owner();
  const c = await saveCustomer(TEST_ORG, { name: "Direct Write", phone: "+13055550150" }, o.memberId);
  // A write straight to the mirror columns.
  await db()
    .update(customers)
    .set({ phones: [...c.phones, "+13055550151"], emails: ["old@example.test"] })
    .where(eq(customers.id, c.id));
  const after = (await getCustomer(TEST_ORG, c.id))!;
  assert.deepEqual(after.contacts.map((x) => [x.name, x.phones, x.emails]), [["Direct Write", ["+13055550150", "+13055550151"], ["old@example.test"]]]);
  // A direct insert, with no contact yet, gets one.
  await db().insert(customers).values({ id: "cus_old", orgId: TEST_ORG, name: "Direct Insert", phones: ["+13055550152"], emails: [] });
  const inserted = await db().select().from(customerContacts).where(and(eq(customerContacts.customerId, "cus_old")));
  assert.deepEqual(inserted.map((x) => [x.name, x.phones, x.preferred]), [["Direct Insert", ["+13055550152"], true]]);
  // The app's own writes add nothing twice.
  await saveCustomer(TEST_ORG, { customerId: c.id, email: "new@example.test" }, o.memberId);
  const final = (await getCustomer(TEST_ORG, c.id))!;
  assert.equal(final.contacts.length, 1);
  assert.deepEqual(final.contacts[0].emails, ["old@example.test", "new@example.test"]);
});

withTestDb("likely same: a new customer's name, phone, or email already on file finds who has it", async () => {
  const o = await owner();
  const ana = await saveCustomer(TEST_ORG, { name: "Ana Núñez", phone: "(305) 555-0144", email: "ana@example.com" }, o.memberId);
  const gone = await saveCustomer(TEST_ORG, { name: "Bo Archived", phone: "305 555 0145" }, o.memberId);
  await archiveCustomer(TEST_ORG, gone.id, o.memberId);
  const ids = async (input: Parameters<typeof likelySameCustomers>[1]) => (await likelySameCustomers(TEST_ORG, input)).map((c) => c.id);

  assert.deepEqual(await ids({ name: "  ana nunez " }), [ana.id]);
  assert.deepEqual(await ids({ name: "Someone Else", phone: "+1 305-555-0144" }), [ana.id]);
  assert.deepEqual(await ids({ email: "ANA@example.com" }), [ana.id]);
  assert.deepEqual(await ids({ name: "Ana" }), []);
  assert.deepEqual(await ids({ phone: "555" }), []);
  assert.deepEqual(await ids({ phone: "305 555 0145" }), []);
  assert.deepEqual(await ids({}), []);
});

withTestDb("list: customers page by their last activity, a quote's change counting, with no overlap or gap", async () => {
  const o = await owner();
  const [item] = await saveItems(TEST_ORG, [{ name: "mulch", unitKind: "each", unitLabel: "bag", priceCents: 500 }], o.memberId);
  const names = ["Ann", "Ben", "Cal", "Dee", "Eli"];
  const saved = [];
  for (const [i, name] of names.entries()) {
    const c = await saveCustomer(TEST_ORG, { name: `${name} Sample` }, o.memberId);
    await db().update(customers).set({ updatedAt: new Date(Date.UTC(2026, 9, 1 + i, 12, 0, 0, 123)) }).where(eq(customers.id, c.id));
    saved.push(c);
  }
  // Ann's quote changed last of all, so she's the most recent.
  const quote = await createQuote({ title: "1 Sample St", customerId: saved[0].id, lines: [{ itemId: item.id, quantity: 1 }] }, o, { post: quiet, now: NOW });
  await db().update(quotes).set({ updatedAt: new Date("2026-10-15T12:00:00.456789Z") }).where(eq(quotes.id, quote.quoteId));
  const first = (row: { name: string }) => row.name.split(" ")[0];

  const page1 = await listCustomers(TEST_ORG, { limit: 2 });
  assert.deepEqual(page1.map(first), ["Ann", "Eli"]);
  assert.equal(page1[0].lastActivityAt.toISOString(), "2026-10-15T12:00:00.456Z");
  const page2 = await listCustomers(TEST_ORG, { before: customerCursor(page1[1]), limit: 2 });
  assert.deepEqual(page2.map(first), ["Dee", "Cal"]);
  const page3 = await listCustomers(TEST_ORG, { before: customerCursor(page2[1]), limit: 2 });
  assert.deepEqual(page3.map(first), ["Ben"]);
  assert.deepEqual(await listCustomers(TEST_ORG, { before: customerCursor(page3[0]), limit: 2 }), []);
  // Back the other way, still most recent first.
  assert.deepEqual((await listCustomers(TEST_ORG, { after: customerCursor(page3[0]), limit: 2 })).map(first), ["Dee", "Cal"]);
  assert.deepEqual((await listCustomers(TEST_ORG, { after: customerCursor(page2[0]), limit: 2 })).map(first), ["Ann", "Eli"]);
  // A search keeps its top matches and ignores a cursor.
  assert.deepEqual((await listCustomers(TEST_ORG, { query: "ben", before: customerCursor(page1[0]) })).map(first), ["Ben"]);
});

import assert from "node:assert/strict";
import { saveCustomer } from "../../core/customers";
import { saveItems } from "../../core/pricebook";
import { approveQuote, createQuote, type Poster } from "../../core/quotes";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { POST as createRoute } from "../../app/api/notes/route";
import { PATCH as noteRoute } from "../../app/api/notes/[id]/route";
import { notesFor } from "./notes";
import { appCaller, call, installTransport, otherBusiness, person, refused, signIn, superAdminViewing } from "./test-support";

const quiet: Poster = async () => ({ posted: true });

withTestDb("notes page: owners write how the business works; everyone reads every note and adds site notes, changing only their own", async () => {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const crew = await person("Sam Crew", "member", "+15555550102");
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.memberId);
  const mine = await saveCustomer(TEST_ORG, { name: "Ada Sample", address: "12 Oak St" }, owner.memberId);
  const notMine = await saveCustomer(TEST_ORG, { name: "Bo Sample", address: "40 Pine Ave" }, owner.memberId);
  const crewQuote = await createQuote({ title: "12 Oak St", customerId: mine.id, lines: [{ itemId: item.id, quantity: 1 }] }, crew, { post: quiet });
  await approveQuote(crewQuote.quoteId, owner, { post: quiet });
  const other = await otherBusiness();
  const otherOwner = await person("Kim Other", "owner", "+15555550201", other);
  const elsewhere = await saveCustomer(other, { name: "Ada Elsewhere" }, otherOwner.memberId);

  const ownerHeaders = await signIn("+15555550101");
  const crewHeaders = await signIn("+15555550102");

  refused(await call(createRoute, crewHeaders, { method: "POST", body: { title: "Our way", body: "x" } }), 403, "NOTE_BUSINESS_PRIVILEGED");
  const wiped = await call(createRoute, ownerHeaders, { method: "POST", body: { title: "Sill wiping", body: "Always wipe the sills, no charge.", tags: ["included"] } });
  assert.equal(wiped.status, 200, JSON.stringify(wiped.body));
  const wipedNote = wiped.body?.note as { id: string; revision: number };
  const pine = await call(createRoute, ownerHeaders, { method: "POST", body: { title: "Dog", body: "Friendly dog", customerId: notMine.id } });
  const pineNote = pine.body?.note as { id: string; revision: number };
  refused(await call(createRoute, ownerHeaders, { method: "POST", body: { title: "x", customerId: elsewhere.id } }), 404);
  refused(await call(createRoute, ownerHeaders, { method: "POST", body: { title: "x", orgId: other } }), 400, "INVALID_INPUT");

  const crewNote = await call(createRoute, crewHeaders, { method: "POST", body: { title: "Side door", body: "Use the side door", customerId: mine.id } });
  assert.equal(crewNote.status, 200, JSON.stringify(crewNote.body));
  const hose = await call(createRoute, crewHeaders, { method: "POST", body: { title: "Hose", body: "By the back steps", customerId: notMine.id } });
  assert.equal(hose.status, 200, JSON.stringify(hose.body));
  refused(await call(noteRoute, crewHeaders, { method: "PATCH", params: { id: wipedNote.id }, body: { body: "x" } }), 403, "NOTE_NOT_YOURS");
  refused(await call(noteRoute, crewHeaders, { method: "PATCH", params: { id: pineNote.id }, body: { body: "x" } }), 403, "NOTE_NOT_YOURS");

  // An edit from an older read is refused.
  refused(await call(noteRoute, ownerHeaders, { method: "PATCH", params: { id: wipedNote.id }, body: { body: "v2", expectedRevision: 1 } }), 200);
  refused(await call(noteRoute, ownerHeaders, { method: "PATCH", params: { id: wipedNote.id }, body: { body: "v3", expectedRevision: 1 } }), 409, "REVISION_CHANGED");

  const crewPage = await notesFor(await appCaller(crewHeaders));
  assert.deepEqual(crewPage.business.map((n) => n.title), ["Sill wiping"]);
  assert.deepEqual(crewPage.linked.map((n) => n.title).sort(), ["Dog", "Hose", "Side door"]);
  const ownerPage = await notesFor(await appCaller(ownerHeaders));
  assert.deepEqual(ownerPage.linked.map((n) => n.title).sort(), ["Dog", "Hose", "Side door"]);
  assert.deepEqual((await notesFor(await appCaller(ownerHeaders), "dog")).linked.map((n) => n.title), ["Dog"]);
  assert.deepEqual((await notesFor(await appCaller(crewHeaders), "dog")).linked.map((n) => n.title), ["Dog"]);

  // Archived notes leave the page.
  refused(await call(noteRoute, ownerHeaders, { method: "PATCH", params: { id: pineNote.id }, body: { archived: true } }), 200);
  assert.deepEqual((await notesFor(await appCaller(ownerHeaders))).linked.map((n) => n.title).sort(), ["Hose", "Side door"]);

  const admin = await superAdminViewing(TEST_ORG);
  assert.equal((await notesFor(await appCaller(admin))).business.length, 1);
  refused(await call(createRoute, admin, { method: "POST", body: { title: "y" } }), 403, "NOT_A_MEMBER");
});

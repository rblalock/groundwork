import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { messages } from "../schema/schema";
import { saveCustomer } from "./customers";
import { db } from "./db";
import { addPhone, createMember, type Caller } from "./members";
import { businessNotes, getNote, listNotes, saveNote, takeRecentFiles } from "./notes";
import { saveItems } from "./pricebook";
import { approveQuote, createQuote, type Poster } from "./quotes";
import { searchRecords } from "./records";
import { bookVisit } from "./scheduling";
import { TEST_ORG, withTestDb } from "./test-db";
import { confirmedEarlier } from "./confirmations";
import mergeCustomersTool from "../agents/assistant/agent/tools/merge_customers";
import archiveCustomerTool from "../agents/assistant/agent/tools/archive_customer";
import { getCustomer } from "./customers";

const quiet: Poster = async () => ({ posted: true });
const NOW = new Date("2026-10-20T16:00:00Z");

async function people() {
  const caller = async (name: string, role: Caller["role"]): Promise<Caller> => {
    const m = await createMember({ orgId: TEST_ORG, name, role });
    return { orgId: TEST_ORG, memberId: m.id, name, role, language: "en", phoneE164: null };
  };
  return { owner: await caller("Pat Owner", "owner"), admin: await caller("Ann Admin", "admin"), crew: await caller("Sam Crew", "member"), other: await caller("Cy Crew", "member") };
}

/** A customer at 12 Oak St with a quote Sam started, and one at 40 Pine Ave that only the owner works with. */
async function seed() {
  const p = await people();
  const [item] = await saveItems(TEST_ORG, [{ name: "Widget service", unitKind: "each", unitLabel: "widget", priceCents: 1000 }], p.owner.memberId);
  const oak = await saveCustomer(TEST_ORG, { name: "Ada Sample", address: "12 Oak St" }, p.owner.memberId);
  const pine = await saveCustomer(TEST_ORG, { name: "Bo Sample", address: "40 Pine Ave" }, p.owner.memberId);
  const crewQuote = await createQuote({ title: "12 Oak St", customerId: oak.id, propertyId: oak.properties[0].id, lines: [{ itemId: item.id, quantity: 2 }] }, p.crew, {
    post: quiet,
    now: NOW,
  });
  // Signed off, so Oak St is crew's work (a crew draft alone isn't).
  await approveQuote(crewQuote.quoteId, p.owner, { post: quiet });
  const ownerQuote = await createQuote({ title: "40 Pine Ave", customerId: pine.id, lines: [{ itemId: item.id, quantity: 3 }] }, p.owner, { post: quiet, now: NOW });
  return { ...p, item, oak, pine, crewQuote, ownerQuote };
}

withTestDb("notes: owners and admins write business-wide notes; crew read them and can't write them", async () => {
  const s = await seed();
  const note = await saveNote(s.owner, { title: "Sill wiping", body: "We always wipe the sills and don't charge for it.", tags: ["Included", " included ", "#Free"] });
  assert.deepEqual([note.kind, note.tags, note.revision, note.createdByName], ["note", ["included", "free"], 1, "Pat Owner"]);
  const edited = await saveNote(s.admin, { noteId: note.id, body: "We always wipe the sills. No charge." }, { expectedRevision: 1 });
  assert.deepEqual([edited.revision, edited.title, edited.updatedByName], [2, "Sill wiping", "Ann Admin"]);
  await assert.rejects(saveNote(s.owner, { noteId: note.id, body: "x" }, { expectedRevision: 1 }), /REVISION_CHANGED/);

  await assert.rejects(saveNote(s.crew, { title: "Our way", body: "x" }), /NOTE_BUSINESS_PRIVILEGED/);
  await assert.rejects(saveNote(s.crew, { noteId: note.id, body: "x" }), /NOTE_NOT_YOURS/);
  assert.equal((await getNote(s.crew, note.id))?.body, "We always wipe the sills. No charge.");
  assert.deepEqual((await businessNotes(TEST_ORG)).map((n) => n.id), [note.id]);
  await assert.rejects(saveNote(s.owner, { body: "no title" }), /NOTE_TITLE_REQUIRED/);

  await saveNote(s.owner, { noteId: note.id, archived: true });
  assert.deepEqual(await businessNotes(TEST_ORG), []);
  assert.deepEqual(await listNotes(s.owner), []);
  assert.equal((await listNotes(s.owner, { includeArchived: true })).length, 1);
  assert.deepEqual((await listNotes(s.crew, { archived: true })).map((n) => n.id), [note.id]);

  // Brought back from the revision the archived view showed, it's live again and no longer archived.
  const archived = await getNote(s.owner, note.id);
  await assert.rejects(saveNote(s.owner, { noteId: note.id, archived: false }, { expectedRevision: (archived?.revision ?? 0) - 1 }), /REVISION_CHANGED/);
  const back = await saveNote(s.owner, { noteId: note.id, archived: false }, { expectedRevision: archived?.revision });
  assert.equal(back.archivedAt, null);
  assert.deepEqual((await listNotes(s.owner)).map((n) => n.id), [note.id]);
  assert.deepEqual(await listNotes(s.owner, { archived: true }), []);
  assert.deepEqual((await businessNotes(TEST_ORG)).map((n) => n.id), [note.id]);
});

withTestDb("notes: everyone reads every note and adds site notes anywhere; crew change only their own", async () => {
  const s = await seed();
  const ownerSite = await saveNote(s.owner, { title: "Gate code", body: "Gate code 4821", propertyId: s.oak.properties[0].id });
  assert.equal(ownerSite.customerId, s.oak.id, "a property brings its customer");
  const pineNote = await saveNote(s.owner, { title: "Dog", body: "Big friendly dog", customerId: s.pine.id });
  const onQuote = await saveNote(s.owner, { title: "Parking", body: "Park on the street", quoteId: s.ownerQuote.quoteId });
  assert.equal(onQuote.customerId, s.pine.id, "a quote brings its customer");
  const business = await saveNote(s.owner, { title: "Boots off", body: "Shoe covers inside" });

  // Sam adds site notes on any customer or quote, his own work or not.
  const crewNote = await saveNote(s.crew, { title: "Side door", body: "Use the side door", customerId: s.oak.id });
  const onPine = await saveNote(s.crew, { title: "Hose", body: "Hose is by the back steps", customerId: s.pine.id });
  const onOwnersQuote = await saveNote(s.crew, { title: "Ladder", body: "Bring the tall ladder", quoteId: s.ownerQuote.quoteId });
  await assert.rejects(saveNote(s.crew, { noteId: pineNote.id, body: "x" }), /NOTE_NOT_YOURS/, "he reads it but didn't write it");
  assert.equal((await saveNote(s.crew, { noteId: crewNote.id, customerId: s.pine.id })).customerId, s.pine.id);
  await assert.rejects(saveNote(s.owner, { title: "x", customerId: s.oak.id, propertyId: s.pine.properties[0].id }), /PROPERTY_MISMATCH/);

  const ids = (notes: Array<{ id: string }>) => notes.map((n) => n.id).sort();
  const all = ids([ownerSite, pineNote, onQuote, business, crewNote, onPine, onOwnersQuote]);
  assert.deepEqual(ids(await listNotes(s.crew)), all);
  assert.deepEqual(ids(await listNotes(s.other)), all);
  assert.deepEqual(ids(await listNotes(s.owner)), all);
  assert.deepEqual(ids(await listNotes(s.owner, { scope: "business" })), [business.id]);
  assert.equal((await getNote(s.crew, pineNote.id))?.id, pineNote.id);
  assert.equal((await getNote(s.other, ownerSite.id))?.id, ownerSite.id);
});

withTestDb("notes: a file the member just texted is kept as a document and set aside from quotes", async () => {
  const s = await seed();
  const phone = await addPhone(TEST_ORG, s.owner.memberId, "+15555550101");
  await db().insert(messages).values({
    id: "msg_warranty",
    orgId: TEST_ORG,
    memberId: s.owner.memberId,
    phoneE164: phone.e164,
    direction: "inbound",
    kind: "user",
    body: "keep this, it's the warranty for Ada",
    attachments: [{ type: "file", url: "fake://warranty.pdf", name: "warranty.pdf", mimeType: "application/pdf" }],
  });
  const files = await takeRecentFiles(TEST_ORG, s.owner.memberId);
  assert.deepEqual(files, [{ url: "fake://warranty.pdf", name: "warranty.pdf", mimeType: "application/pdf", type: "file" }]);
  const [message] = await db().select().from(messages).where(eq(messages.id, "msg_warranty"));
  assert.equal(message.attachments[0].document, true);
  const doc = await saveNote(s.owner, { title: "Ada's warranty", body: "Two-year warranty on the work, from the PDF.", customerId: s.oak.id, files, tags: ["warranty"] });
  assert.equal(doc.kind, "document");
  assert.equal((await searchRecords(s.owner, "warranty ada")).results[0]?.id, doc.id);
  assert.equal((await searchRecords(s.owner, "warranty.pdf")).results[0]?.id, doc.id, "a file's name finds it");
  assert.deepEqual(await takeRecentFiles(TEST_ORG, s.crew.memberId), []);
});

withTestDb("search: every word matches, best first, across notes, customers, quotes, and invoices; crew get everything but invoices", async () => {
  const s = await seed();
  const gate = await saveNote(s.owner, { title: "Gate code", body: "Gate code 4821. The latch sticks.", propertyId: s.oak.properties[0].id });
  const sills = await saveNote(s.owner, { title: "Sill wiping", body: "We always wipe the sills and don't charge for it." });
  const pineGate = await saveNote(s.owner, { title: "Pine Ave gate", body: "The side gate is chained, use the front", customerId: s.pine.id });

  const hit = await searchRecords(s.owner, "gate code 12 Oak");
  assert.equal(hit.matched, "all");
  assert.equal(hit.results[0]?.id, gate.id, "the note whose title and address match comes first");
  assert.ok(hit.results.every((r) => r.id !== sills.id));
  assert.equal((await searchRecords(s.owner, "gáte códe")).results[0]?.id, gate.id, "accents fold");
  assert.equal((await searchRecords(s.owner, "4821")).results[0]?.id, gate.id);
  assert.equal((await searchRecords(s.owner, "sill")).results[0]?.id, sills.id, "a word's start matches");
  // A whole question: nothing has every word, so the best of any come back, marked as such.
  const question = await searchRecords(s.owner, "what's the gate code at 12 Oak St?");
  assert.equal(question.matched, "any");
  assert.equal(question.results[0]?.id, gate.id);

  const oakQuote = await searchRecords(s.owner, "oak", { kinds: ["quote"] });
  assert.deepEqual(oakQuote.results.map((r) => [r.kind, r.id]), [["quote", s.crewQuote.quoteId]]);
  assert.deepEqual((await searchRecords(s.owner, "Bo Sample", { kinds: ["customer"] })).results.map((r) => r.id), [s.pine.id]);
  assert.deepEqual((await searchRecords(s.owner, "nothing like this")).results, []);

  // Sam: every note, customer, and quote, his own work or not; no invoices.
  const crewHits = await searchRecords(s.crew, "gate");
  assert.deepEqual(crewHits.results.map((r) => r.id).sort(), [gate.id, pineGate.id].sort());
  assert.ok((await searchRecords(s.crew, "pine")).results.some((r) => r.id === s.pine.id));
  assert.deepEqual((await searchRecords(s.crew, "sills")).results.map((r) => r.id), [sills.id], "business-wide notes are for everyone");
  assert.deepEqual((await searchRecords(s.crew, "sample", { kinds: ["customer"] })).results.map((r) => r.id).sort(), [s.oak.id, s.pine.id].sort());
  assert.deepEqual((await searchRecords(s.crew, "widget", { kinds: ["invoice"] })).results, []);
});

withTestDb("merge and archive tools ask first, and act only on a yes in a later turn", async () => {
  const s = await seed();
  const dup = await saveCustomer(TEST_ORG, { name: "A. Sample", address: "12 Oak St" }, s.owner.memberId);
  const ctx = (caller: Caller, sequence: number) => ({
    session: {
      id: "ses_merge",
      turn: { id: `turn_${sequence}`, sequence },
      auth: { current: { authenticator: "photon-imessage", principalId: `member:${caller.memberId}`, attributes: { orgId: TEST_ORG, memberId: caller.memberId } } },
    },
  });
  type Out = Record<string, any>;
  const merge = async (caller: Caller, sequence: number) =>
    (await mergeCustomersTool.execute({ keepCustomerId: s.oak.id, mergeCustomerId: dup.id }, ctx(caller, sequence) as never)) as Out;

  assert.match((await merge(s.crew, 1)).error, /NOT_PRIVILEGED/);
  const asked = await merge(s.owner, 1);
  assert.equal(asked.status, "confirm");
  assert.equal(asked.merge.name, "A. Sample");
  // Asked again in the same turn: still a question.
  assert.equal((await merge(s.owner, 1)).status, "confirm");
  assert.equal((await getCustomer(TEST_ORG, dup.id))?.archivedAt, null);
  // Another conversation's question doesn't count.
  assert.equal(
    await confirmedEarlier({ orgId: TEST_ORG, memberId: s.owner.memberId, action: "merge_customers", subject: `${s.oak.id}<${dup.id}`, turn: { sessionId: "ses_other", turnSequence: 9 } }),
    false,
  );
  const merged = await merge(s.owner, 2);
  assert.equal(merged.status, "merged");
  assert.equal((await getCustomer(TEST_ORG, dup.id))?.mergedIntoId, s.oak.id);

  const archive = async (sequence: number) =>
    (await archiveCustomerTool.execute({ customerId: s.pine.id }, ctx(s.owner, sequence) as never)) as Out;
  const askedArchive = await archive(3);
  assert.deepEqual([askedArchive.status, askedArchive.onRecord.quotes], ["confirm", 1]);
  assert.equal((await archive(4)).status, "archived");
  assert.ok((await getCustomer(TEST_ORG, s.pine.id))?.archivedAt);
});

// Edits made from the pages, not only by text: price book items and rules, an invoice from scratch, and
// notes (and kept files) on a quote. Each goes through the same library as the assistant, with the same
// limits on who may.
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { pricebookChanges, pricebookItems } from "../../schema/schema";
import { saveCustomer } from "../../core/customers";
import { db } from "../../core/db";
import { getInvoice } from "../../core/invoices";
import { listRules, saveItems } from "../../core/pricebook";
import { createQuote, type Poster } from "../../core/quotes";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { POST as createInvoiceRoute } from "../../app/api/invoices/route";
import { POST as createNoteRoute } from "../../app/api/notes/route";
import { POST as noteFileRoute } from "../../app/api/notes/[id]/files/route";
import { POST as createItemRoute } from "../../app/api/price-book/items/route";
import { PATCH as itemRoute } from "../../app/api/price-book/items/[id]/route";
import { POST as createRuleRoute } from "../../app/api/price-book/rules/route";
import { keptFileType, quoteNotesFor } from "./notes";
import { appCaller, BASE, call, installTransport, otherBusiness, person, refused, signIn } from "./test-support";

const quiet: Poster = async () => ({ posted: true });

async function seed() {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const crew = await person("Sam Crew", "member", "+15555550102");
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.memberId);
  const customer = await saveCustomer(TEST_ORG, { name: "Ada Sample", address: "1 Sample St" }, owner.memberId);
  const ownerQuote = await createQuote({ title: "1 Sample St", customerId: customer.id, lines: [{ itemId: item.id, quantity: 2 }] }, owner, { post: quiet });
  const crewQuote = await createQuote({ title: "2 Sample St", lines: [{ itemId: item.id, quantity: 1 }] }, crew, { post: quiet });
  const other = await otherBusiness();
  const otherOwner = await person("Kim Other", "owner", "+15555550201", other);
  const [otherItem] = await saveItems(other, [{ name: "gadget fitting", unitKind: "each", unitLabel: "gadget", priceCents: 500 }], otherOwner.memberId);
  const otherCustomer = await saveCustomer(other, { name: "Lee Other" }, otherOwner.memberId);
  const otherQuote = await createQuote({ title: "9 Other Rd", lines: [{ itemId: otherItem.id, quantity: 1 }] }, otherOwner, { post: quiet });
  return {
    owner,
    crew,
    item,
    customer,
    ownerQuote,
    crewQuote,
    otherItem,
    otherCustomer,
    otherQuote,
    ownerHeaders: await signIn("+15555550101"),
    crewHeaders: await signIn("+15555550102"),
  };
}

/** Posts a file to a note, as the browser's form does. */
async function upload(headers: Headers, noteId: string, name: string, bytes: Uint8Array, type = "application/octet-stream") {
  const form = new FormData();
  form.append("file", new File([bytes as Uint8Array<ArrayBuffer>], name, { type }));
  const request = new Request(`${BASE}/api/notes/${noteId}/files`, { method: "POST", headers: { cookie: headers.get("cookie") ?? "" }, body: form });
  const response = await noteFileRoute(request, { params: Promise.resolve({ id: noteId }) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const PDF = new TextEncoder().encode("%PDF-1.4\n%fake\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

withTestDb("price book from the page: owners add and edit items; crew can't; a name already in the book is refused", async () => {
  const s = await seed();
  const added = await call(createItemRoute, s.ownerHeaders, {
    body: { name: "Gutter cleaning", unitKind: "linear_ft", unitLabel: "foot", priceCents: 200, taxable: false },
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const item = (added.body?.item as { id: string; taxable: boolean; unitKind: string });
  assert.equal(item.taxable, false);
  assert.equal(item.unitKind, "linear_ft");
  refused(await call(createItemRoute, s.ownerHeaders, { body: { name: "  widget SERVICE ", unitKind: "each", unitLabel: "widget", priceCents: 1 } }), 409, "NAME_TAKEN");
  refused(await call(createItemRoute, s.crewHeaders, { body: { name: "Crew price", unitKind: "each", unitLabel: "x", priceCents: 1 } }), 403, "NOT_PRIVILEGED");
  refused(await call(createItemRoute, s.ownerHeaders, { body: { name: "No unit", unitKind: "each", unitLabel: "", priceCents: 1 } }), 400, "INVALID_INPUT");

  const edited = await call(itemRoute, s.ownerHeaders, {
    method: "PATCH",
    params: { id: s.item.id },
    body: { name: "Widget care", unitKind: "hour", unitLabel: "hour", priceCents: 1300, taxable: false },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const [row] = await db().select().from(pricebookItems).where(eq(pricebookItems.id, s.item.id));
  assert.deepEqual([row.name, row.unitKind, row.unitLabel, row.priceCents, row.taxable], ["Widget care", "hour", "hour", 1300, false]);
  const fields = (await db().select().from(pricebookChanges).where(eq(pricebookChanges.itemId, s.item.id))).map((c) => c.field).sort();
  assert.deepEqual(fields, ["name", "price_cents", "taxable", "unit_kind", "unit_label"]);

  refused(await call(itemRoute, s.ownerHeaders, { method: "PATCH", params: { id: s.item.id }, body: { name: "gutter cleaning" } }), 409, "NAME_TAKEN");
  refused(await call(itemRoute, s.ownerHeaders, { method: "PATCH", params: { id: s.otherItem.id }, body: { name: "Mine now" } }), 404);
  refused(await call(itemRoute, s.crewHeaders, { method: "PATCH", params: { id: s.item.id }, body: { taxable: true } }), 403, "NOT_PRIVILEGED");
});

withTestDb("price book from the page: owners add a rule, with a price change on one of their items or every one", async () => {
  const s = await seed();
  const plain = await call(createRuleRoute, s.ownerHeaders, { body: { text: "Bring two ladders for tall jobs", kind: "process" } });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  const priced = await call(createRuleRoute, s.ownerHeaders, {
    body: { text: "Add $5 per widget for second floors", kind: "pricing_modifier", effect: { op: "add_per_unit", amount: 500, appliesTo: [s.item.id] } },
  });
  assert.equal(priced.status, 201, JSON.stringify(priced.body));
  const discount = await call(createRuleRoute, s.ownerHeaders, {
    body: { text: "10% off for repeat customers", kind: "pricing_modifier", effect: { op: "percent", amount: -1000, appliesTo: "any" } },
  });
  assert.equal(discount.status, 201, JSON.stringify(discount.body));
  const active = await listRules(TEST_ORG);
  assert.deepEqual(active.map((r) => r.status), ["active", "active", "active"]);
  assert.deepEqual(active.find((r) => r.kind === "pricing_modifier" && r.effect?.op === "add_per_unit")?.effect, { op: "add_per_unit", amount: 500, appliesTo: [s.item.id] });

  refused(await call(createRuleRoute, s.ownerHeaders, { body: { text: "Theirs", kind: "pricing_modifier", effect: { op: "add_fixed", amount: 100, appliesTo: [s.otherItem.id] } } }), 404);
  refused(await call(createRuleRoute, s.ownerHeaders, { body: { text: "Scope", kind: "scope", effect: { op: "add_fixed", amount: 100, appliesTo: "any" } } }), 400, "INVALID_INPUT");
  refused(await call(createRuleRoute, s.crewHeaders, { body: { text: "Crew rule", kind: "other" } }), 403, "NOT_PRIVILEGED");
});

withTestDb("an invoice from scratch: owners start a draft for a customer or no one; crew can't", async () => {
  const s = await seed();
  const lines = [{ name: "Pressure washing", quantity: 2, unitLabel: "hour", unitCents: 7500 }];
  const made = await call(createInvoiceRoute, s.ownerHeaders, { body: { title: "Driveway", customerId: s.customer.id, lines } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const invoice = await getInvoice(TEST_ORG, made.body?.invoiceId as string);
  assert.equal(invoice?.status, "draft");
  assert.equal(invoice?.customerId, s.customer.id);
  assert.equal(invoice?.title, "Driveway");
  assert.equal(invoice?.subtotalCents, 15000);

  const nobody = await call(createInvoiceRoute, s.ownerHeaders, { body: { title: "Walk-in", lines } });
  assert.equal(nobody.status, 201, JSON.stringify(nobody.body));
  assert.equal((await getInvoice(TEST_ORG, nobody.body?.invoiceId as string))?.customerId, null);

  refused(await call(createInvoiceRoute, s.ownerHeaders, { body: { title: "No lines" } }), 400, "INVALID_INPUT");
  refused(await call(createInvoiceRoute, s.ownerHeaders, { body: { lines } }), 400, "INVALID_INPUT");
  refused(await call(createInvoiceRoute, s.ownerHeaders, { body: { title: "Both", quoteId: s.ownerQuote.quoteId, lines } }), 400, "INVALID_INPUT");
  refused(await call(createInvoiceRoute, s.ownerHeaders, { body: { title: "Theirs", customerId: s.otherCustomer.id, lines } }), 404);
  refused(await call(createInvoiceRoute, s.crewHeaders, { body: { title: "Crew", lines } }), 403, "NOT_PRIVILEGED");
});

withTestDb("notes on a quote from its page: anyone on the team, on any quote; another business's is missing", async () => {
  const s = await seed();
  const onOwner = await call(createNoteRoute, s.ownerHeaders, { body: { title: "Gate code", body: "1234", quoteId: s.ownerQuote.quoteId } });
  assert.equal(onOwner.status, 200, JSON.stringify(onOwner.body));
  const note = onOwner.body?.note as { quoteId: string; customerId: string };
  assert.equal(note.quoteId, s.ownerQuote.quoteId);
  assert.equal(note.customerId, s.customer.id, "a quote's note is on its customer too");
  const owner = await appCaller(s.ownerHeaders);
  assert.deepEqual((await quoteNotesFor(owner, s.ownerQuote.quoteId)).map((n) => n.title), ["Gate code"]);

  const onCrew = await call(createNoteRoute, s.crewHeaders, { body: { title: "Dog in yard", quoteId: s.crewQuote.quoteId } });
  assert.equal(onCrew.status, 200, JSON.stringify(onCrew.body));
  const onOwners = await call(createNoteRoute, s.crewHeaders, { body: { title: "Ladder", quoteId: s.ownerQuote.quoteId } });
  assert.equal(onOwners.status, 200, JSON.stringify(onOwners.body));
  refused(await call(createNoteRoute, s.ownerHeaders, { body: { title: "Theirs", quoteId: s.otherQuote.quoteId } }), 404);
});

withTestDb("keeping a file on a note: PDFs and photos by their bytes, up to 4 MB, on notes the member may change", async () => {
  const s = await seed();
  const made = await call(createNoteRoute, s.ownerHeaders, { body: { title: "Warranty", quoteId: s.ownerQuote.quoteId } });
  const noteId = (made.body?.note as { id: string }).id;

  const pdf = await upload(s.ownerHeaders, noteId, "warranty.pdf", PDF);
  assert.equal(pdf.status, 200, JSON.stringify(pdf.body));
  const kept = pdf.body.note as { kind: string; files: Array<{ name: string; mimeType: string }> };
  assert.equal(kept.kind, "document");
  assert.deepEqual(kept.files.map((f) => [f.name, f.mimeType]), [["warranty.pdf", "application/pdf"]]);
  const png = await upload(s.ownerHeaders, noteId, "site.png", PNG, "image/png");
  assert.equal((png.body.note as { files: unknown[] }).files.length, 2);

  // The browser's word and the name don't count: the bytes do.
  assert.equal((await upload(s.ownerHeaders, noteId, "logo.png", SVG, "image/png")).status, 415);
  assert.equal((await upload(s.ownerHeaders, noteId, "big.pdf", new Uint8Array([...PDF, ...new Uint8Array(4 * 1024 * 1024)]))).status, 413);
  // Crew read an owner's note but don't change it.
  assert.equal((await upload(s.crewHeaders, noteId, "mine.pdf", PDF)).status, 403);

  assert.equal(keptFileType(PDF), "application/pdf");
  assert.equal(keptFileType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(keptFileType(SVG), null);
});

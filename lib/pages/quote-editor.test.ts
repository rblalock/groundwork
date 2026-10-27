import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// PDFs and photos go to a temp folder, so a revision's PDF renders as it would in production.
const blobDir = mkdtempSync(join(tmpdir(), "gw-quote-editor-"));
process.env.BLOB_LOCAL_DIR = blobDir;

import assert from "node:assert/strict";
import { desc, eq } from "drizzle-orm";
import { messages, quoteAttachments, quoteRevisions } from "../../schema/schema";
import { db, newId } from "../../core/db";
import { saveItems } from "../../core/pricebook";
import { approveQuote, createQuote, getQuote, linkRecentAttachments, type Poster } from "../../core/quotes";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { PATCH as editRoute } from "../../app/api/quotes/[id]/route";
import { POST as photosRoute } from "../../app/api/quotes/[id]/photos/route";
import { QUOTE_PHOTO_MAX_BYTES } from "./quote-editor";
import { call, installTransport, otherBusiness, person, refused, signIn, superAdminViewing, texts } from "./test-support";

// Editing a quote on its page: a new revision through `reviseQuote`, priced in code, for whoever may
// change the quote, refused when it moved on since the page loaded.

const quiet: Poster = async () => ({ posted: true });

async function seed() {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const crew = await person("Sam Crew", "member", "+15555550102");
  const otherCrew = await person("Lu Crew", "member", "+15555550103");
  const [windows, gutters] = await saveItems(
    TEST_ORG,
    [
      { name: "Window cleaning", unitKind: "each", unitLabel: "window", priceCents: 1000 },
      { name: "Gutter cleaning", unitKind: "linear_ft", unitLabel: "ft", priceCents: 200 },
    ],
    owner.memberId,
  );
  const quote = await createQuote({ title: "1 Example St", lines: [{ itemId: windows.id, quantity: 4 }] }, crew, { post: quiet });
  return { owner, crew, otherCrew, windows, gutters, quote };
}

withTestDb("an edit on the page is a new revision, priced in code, and texts no one", async () => {
  const { crew, windows, gutters, quote } = await seed();
  const headers = await signIn(crew.phoneE164!);
  const before = texts.length;

  const saved = await call(editRoute, headers, {
    method: "PATCH",
    params: { id: quote.quoteId },
    body: {
      revision: quote.revisionNumber,
      lines: [
        { itemId: windows.id, quantity: 6 },
        { itemId: gutters.id, quantity: 50, unitCents: 150 },
        { name: "Haul away", unitLabel: "load", quantity: 1, unitCents: 4000 },
      ],
      customerNotes: "Back gate is open.",
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body?.revision, quote.revisionNumber + 1);

  const now = (await getQuote(TEST_ORG, quote.quoteId))!;
  assert.equal(now.revisionNumber, quote.revisionNumber + 1);
  // 6 × $10 + 50 × $1.50 (set on this quote) + $40.
  assert.deepEqual(now.lines.map((l) => l.totalCents), [6000, 7500, 4000]);
  assert.deepEqual(
    now.lines.map((l) => [l.name, l.source]),
    [
      ["Window cleaning", "pricebook"],
      ["Gutter cleaning", "override"],
      ["Haul away", "override"],
    ],
  );
  assert.equal(now.customerNotes, "Back gate is open.");
  assert.ok(now.pdfUrl, "the new revision has its PDF");
  assert.equal(texts.length, before, "nothing is texted from the page");
});

withTestDb("an approved quote edited on the page goes back for approval", async () => {
  const { owner, windows, quote } = await seed();
  const approved = await approveQuote(quote.quoteId, owner, { post: quiet });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const current = (await getQuote(TEST_ORG, quote.quoteId))!;
  const saved = await call(editRoute, await signIn(owner.phoneE164!), {
    method: "PATCH",
    params: { id: quote.quoteId },
    body: { revision: current.revisionNumber, lines: [{ itemId: windows.id, quantity: 5 }] },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await getQuote(TEST_ORG, quote.quoteId))?.status, "draft");
});

withTestDb("anyone on the team edits a draft, only its owner or an admin one past approval, and only the revision they saw", async () => {
  const { owner, otherCrew, windows, quote } = await seed();
  const body = { revision: quote.revisionNumber, lines: [{ itemId: windows.id, quantity: 2 }] };

  // Another business doesn't see it; a super admin only looks.
  const other = await otherBusiness();
  const outsider = await person("Lee Outsider", "owner", "+15555550109", other);
  refused(await call(editRoute, await signIn(outsider.phoneE164!), { method: "PATCH", params: { id: quote.quoteId }, body }), 404);
  refused(await call(editRoute, await superAdminViewing(TEST_ORG), { method: "PATCH", params: { id: quote.quoteId }, body }), 403, "NOT_A_MEMBER");

  // A stale page, a bad line, and an empty edit are refused; nothing changes.
  const ownerHeaders = await signIn(owner.phoneE164!);
  refused(await call(editRoute, ownerHeaders, { method: "PATCH", params: { id: quote.quoteId }, body: { ...body, revision: quote.revisionNumber + 5 } }), 409, "REVISION_CHANGED");
  refused(await call(editRoute, ownerHeaders, { method: "PATCH", params: { id: quote.quoteId }, body: { revision: quote.revisionNumber, lines: [{ quantity: 1 }] } }), 400, "LINE_NEEDS_ITEM_OR_NAME");
  refused(await call(editRoute, ownerHeaders, { method: "PATCH", params: { id: quote.quoteId }, body: { revision: quote.revisionNumber } }), 400, "INVALID_INPUT");
  assert.equal((await getQuote(TEST_ORG, quote.quoteId))?.revisionNumber, quote.revisionNumber);

  // Another crew member changes it while it's a draft, but not once it's approved.
  const otherCrewHeaders = await signIn(otherCrew.phoneE164!);
  const edited = await call(editRoute, otherCrewHeaders, { method: "PATCH", params: { id: quote.quoteId }, body });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal((await approveQuote(quote.quoteId, owner, { post: quiet })).ok, true);
  const approved = (await getQuote(TEST_ORG, quote.quoteId))!;
  refused(await call(editRoute, otherCrewHeaders, { method: "PATCH", params: { id: quote.quoteId }, body: { ...body, revision: approved.revisionNumber } }), 403, "NOT_ALLOWED");

  // A closed quote stays as it is.
  const outcome = await call((await import("../../app/api/quotes/[id]/outcome/route")).POST, ownerHeaders, { params: { id: quote.quoteId }, body: { outcome: "void" } });
  assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
  const closed = (await getQuote(TEST_ORG, quote.quoteId))!;
  refused(await call(editRoute, ownerHeaders, { method: "PATCH", params: { id: quote.quoteId }, body: { ...body, revision: closed.revisionNumber } }), 403, "NOT_ALLOWED");
});

withTestDb("a photo comes off the quote from the page", async () => {
  const { crew, quote } = await seed();
  const photoFile = join(blobDir, "photo.jpg");
  writeFileSync(photoFile, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]));
  const since = new Date(Date.now() - 60_000);
  await db().insert(messages).values({
    id: newId("msg"),
    orgId: TEST_ORG,
    memberId: crew.memberId,
    phoneE164: crew.phoneE164!,
    direction: "inbound",
    kind: "user",
    body: "",
    attachments: [{ type: "image", url: pathToFileURL(photoFile).href, name: "photo.jpg", mimeType: "image/jpeg" }],
  });
  assert.equal(await linkRecentAttachments(TEST_ORG, quote.quoteId, crew.memberId, since), 1);
  const [photo] = (await getQuote(TEST_ORG, quote.quoteId))!.attachments;
  const headers = await signIn(crew.phoneE164!);

  refused(await call(editRoute, headers, { method: "PATCH", params: { id: quote.quoteId }, body: { revision: quote.revisionNumber, removePhotoIds: ["att_nope"] } }), 404, "PHOTO_NOT_FOUND");
  const removed = await call(editRoute, headers, { method: "PATCH", params: { id: quote.quoteId }, body: { revision: quote.revisionNumber, removePhotoIds: [photo.id] } });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const now = (await getQuote(TEST_ORG, quote.quoteId))!;
  assert.equal(now.attachments.length, 0);
  assert.equal(now.revisionNumber, quote.revisionNumber + 1);
});

// A 1×1 PNG, and the request the Photos card's "Add photos" sends.
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

async function upload(headers: Headers, quoteId: string, bytes: Uint8Array, name = "porch.png") {
  const form = new FormData();
  form.append("file", new File([Buffer.from(bytes)], name, { type: "image/png" }));
  const request = new Request(`http://localhost:3000/api/quotes/${quoteId}/photos`, {
    method: "POST",
    headers: { cookie: headers.get("cookie") ?? "" },
    body: form,
  });
  const response = await photosRoute(request, { params: Promise.resolve({ id: quoteId }) });
  return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> | null };
}

const imagesIn = async (pdfUrl: string | null) => {
  assert.ok(pdfUrl?.startsWith("file://"), `a stored PDF: ${pdfUrl}`);
  return (readFileSync(new URL(pdfUrl!)).toString("latin1").match(/\/Subtype\s*\/Image/g) ?? []).length;
};

withTestDb("a photo uploaded on the page joins the quote like a texted one: a new revision, on the PDF, and it can come off", async () => {
  const { crew, quote } = await seed();
  const headers = await signIn(crew.phoneE164!);
  const before = texts.length;
  const pdfBefore = (await db().select().from(quoteRevisions).where(eq(quoteRevisions.quoteId, quote.quoteId)).orderBy(desc(quoteRevisions.number)))[0];
  assert.equal(await imagesIn(pdfBefore.pdfUrl), 0);

  const added = await upload(headers, quote.quoteId, PNG);
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body?.revision, quote.revisionNumber + 1);
  const detail = await getQuote(TEST_ORG, quote.quoteId);
  assert.equal(detail?.attachments.length, 1);
  assert.equal(detail?.attachments[0].name, "porch.png");
  const [row] = await db().select().from(quoteAttachments).where(eq(quoteAttachments.quoteId, quote.quoteId));
  assert.deepEqual([row.messageId, row.uploadedByMemberId, row.mimeType], [null, crew.memberId, "image/png"]);
  // The new revision's PDF prints it.
  const [current] = await db().select().from(quoteRevisions).where(eq(quoteRevisions.quoteId, quote.quoteId)).orderBy(desc(quoteRevisions.number));
  assert.equal(current.number, quote.revisionNumber + 1);
  // A PNG embeds as its image and its alpha mask.
  assert.ok((await imagesIn(current.pdfUrl)) > 0, "the photo prints on the PDF");
  assert.equal(texts.length, before, "nothing is texted");

  // It comes off like a texted photo.
  const removed = await call(editRoute, headers, {
    method: "PATCH",
    params: { id: quote.quoteId },
    body: { revision: current.number, removePhotoIds: [row.id] },
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal((await getQuote(TEST_ORG, quote.quoteId))?.attachments.length, 0);
});

withTestDb("anyone who may change a quote uploads photos to it, and only JPEG, PNG, or HEIC up to 4 MB", async () => {
  const { owner, otherCrew, quote } = await seed();
  // Another crew member may, on a draft.
  assert.equal((await upload(await signIn(otherCrew.phoneE164!), quote.quoteId, PNG)).status, 201);
  refused(await upload(await superAdminViewing(TEST_ORG), quote.quoteId, PNG), 403, "NOT_A_MEMBER");
  const other = await otherBusiness();
  const outsider = await person("Lee Outsider", "owner", "+15555550109", other);
  refused(await upload(await signIn(outsider.phoneE164!), quote.quoteId, PNG), 404);

  const ownerHeaders = await signIn(owner.phoneE164!);
  // The browser's type says PNG; the bytes say otherwise.
  refused(await upload(ownerHeaders, quote.quoteId, new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "x.png"), 415, "PHOTO_UNSUPPORTED");
  refused(await upload(ownerHeaders, quote.quoteId, Uint8Array.from(Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"))), 415, "PHOTO_UNSUPPORTED");
  const big = new Uint8Array(QUOTE_PHOTO_MAX_BYTES + 1);
  big.set(PNG);
  refused(await upload(ownerHeaders, quote.quoteId, big), 413);
  assert.equal((await getQuote(TEST_ORG, quote.quoteId))?.attachments.length, 1, "only the other crew member's photo");
  assert.equal((await upload(ownerHeaders, quote.quoteId, PNG)).status, 201);
});

/** A PNG whose header claims a 20,000 × 20,000 canvas in a few dozen bytes. */
function hugePng(): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(20_000, 0);
  ihdr.writeUInt32BE(20_000, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    return out;
  };
  return Uint8Array.from(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", Buffer.alloc(8)), chunk("IEND", Buffer.alloc(0))]));
}

/** A JPEG whose frame header (SOF0) claims 20,000 × 20,000. */
function hugeJpeg(): Uint8Array {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x4e, 0x20, 0x4e, 0x20, 0x03, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
  return Uint8Array.from(Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]));
}

const storedFiles = () => {
  try {
    return readdirSync(join(blobDir, "inbound")).length;
  } catch {
    return 0;
  }
};

withTestDb("a photo whose header claims a huge canvas is refused before it's stored or decoded", async () => {
  const { owner, quote } = await seed();
  const headers = await signIn(owner.phoneE164!);
  const before = storedFiles();
  for (const [bytes, name] of [[hugePng(), "bomb.png"], [hugeJpeg(), "bomb.jpg"]] as const) {
    assert.ok(bytes.length < 200);
    refused(await upload(headers, quote.quoteId, bytes, name), 400, "PHOTO_DIMENSIONS");
  }
  assert.equal(storedFiles(), before, "nothing stored");
  assert.equal((await getQuote(TEST_ORG, quote.quoteId))?.attachments.length, 0);
});

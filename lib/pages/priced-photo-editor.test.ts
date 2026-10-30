// The priced photo editor's routes: anyone on the team reads the editor's state, moves the photo's
// objects between lines, and outlines one by hand; a bad edit is a 400, another business's photo a 404.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.BLOB_LOCAL_DIR = mkdtempSync(join(tmpdir(), "priced-editor-"));

import assert from "node:assert/strict";
import { pricedPhotos, quoteAttachments } from "../../schema/schema";
import type { PricedPhotoEditorState } from "../../schema/types";
import { storeInboundAttachment } from "../../core/blob";
import { db, newId } from "../../core/db";
import { saveItems } from "../../core/pricebook";
import { createQuote, type Poster } from "../../core/quotes";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { GET as regionsGet, PUT as regionsPut } from "../../app/api/quotes/[id]/priced/[pricedId]/regions/route";
import { POST as findPost } from "../../app/api/quotes/[id]/priced/[pricedId]/find/route";
import { POST as drawPost } from "../../app/api/quotes/[id]/priced/[pricedId]/candidates/route";
import { DELETE as drawnDelete } from "../../app/api/quotes/[id]/priced/[pricedId]/candidates/[candidateId]/route";
import { call, installTransport, otherBusiness, person, refused, signIn, superAdminViewing } from "./test-support";

const YARD = readFileSync(new URL("../../agents/assistant/evals/fixtures/yard-front.jpg", import.meta.url));
const quiet: Poster = async () => ({ posted: true });

/** A quote with a photo and a priced photo of it: a hedge line, a shrub line, and one shrub SAM found on neither. */
async function seeded() {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const crew = await person("Sam Crew", "member", "+15555550102");
  const items = await saveItems(
    TEST_ORG,
    [
      { name: "Hedge trimming", unitKind: "other", unitLabel: "cubic foot", priceCents: 250, photoPrompt: "hedge" },
      { name: "Shrub trimming", unitKind: "each", unitLabel: "shrub", priceCents: 1500 },
    ],
    owner.memberId,
  );
  const quote = await createQuote({ title: "412 Oak St", lines: items.map((item) => ({ itemId: item.id, quantity: 2 })) }, owner, { post: quiet });
  const url = await storeInboundAttachment("yard.jpg", "image/jpeg", new Uint8Array(YARD));
  const attachmentId = newId("att");
  await db().insert(quoteAttachments).values({ id: attachmentId, orgId: TEST_ORG, quoteId: quote.quoteId, uploadedByMemberId: owner.memberId, url, name: "yard.jpg", mimeType: "image/jpeg" });
  const shrub = { id: "cand_shrub", phrase: "shrub", box: { left: 0, top: 494, right: 444, bottom: 645 }, areaPx: 43304, confidence: 0.91, svgPath: "M0 494L444 494L444 645L0 645Z" };
  const line = (lineIndex: number, name: string, phrase: string | null) => ({ lineIndex, itemId: null, name, quantity: 2, unitLabel: "unit", totalCents: 500, phrase, objects: [], located: false });
  const pricedId = newId("ppho");
  await db()
    .insert(pricedPhotos)
    .values({
      id: pricedId,
      orgId: TEST_ORG,
      quoteId: quote.quoteId,
      revisionNumber: quote.revisionNumber,
      sourceKind: "quote_attachment",
      sourceId: attachmentId,
      sourceUrl: url,
      url: "fake://priced/before.png",
      customerUrl: "fake://priced/before-customer.png",
      width: 1024,
      height: 1200,
      photoHeight: 1024,
      regions: [line(0, "Hedge trimming", "hedge"), line(1, "Shrub trimming", null)],
      candidates: [shrub],
      memberId: owner.memberId,
    });
  return { owner, crew, quote, attachmentId, shrub, params: { id: quote.quoteId, pricedId } };
}

withTestDb("the priced photo editor: read it, move an object to another line, and bad edits are refused", async () => {
  const { crew, quote, attachmentId, shrub, params } = await seeded();
  const crewHeaders = await signIn(crew.phoneE164!);
  const read = await call(regionsGet, crewHeaders, { params });
  const state = read.body as unknown as PricedPhotoEditorState;
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual([state.width, state.height, state.photoUrl], [1024, 1024, `/api/quotes/${quote.quoteId}/photos/${attachmentId}`]);
  assert.deepEqual(
    state.lines.map((l) => [l.lineIndex, l.name, l.phrase]),
    [
      [0, "Hedge trimming", "hedge"],
      [1, "Shrub trimming", null],
    ],
  );
  assert.equal(state.editedAt, null);

  // The bushes SAM called shrubs are the hedge.
  const moved = await call(regionsPut, crewHeaders, { method: "PUT", params, body: { assignments: [{ candidateId: shrub.id, lineIndexes: [0] }] } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const after = moved.body as unknown as PricedPhotoEditorState;
  assert.deepEqual(
    after.regions.map((r) => [r.located, r.objects.map((o) => o.candidateId)]),
    [
      [true, [shrub.id]],
      [false, []],
    ],
  );
  assert.equal(after.editedBy, "Sam Crew");
  assert.ok(after.editedAt && after.renderedUrl !== state.renderedUrl, "the rendered photo's version changes");

  refused(await call(regionsPut, crewHeaders, { method: "PUT", params, body: { assignments: [{ candidateId: "cand_nope", lineIndexes: [0] }] } }), 400, "UNKNOWN_CANDIDATE");
  refused(await call(regionsPut, crewHeaders, { method: "PUT", params, body: { assignments: [{ candidateId: shrub.id, lineIndexes: [7] }] } }), 400, "UNKNOWN_LINE");
  refused(await call(findPost, crewHeaders, { params, body: { phrase: "   " } }), 400, "BAD_PHRASE");
  refused(await call(regionsPut, await superAdminViewing(TEST_ORG), { method: "PUT", params, body: { assignments: [] } }), 403);
  const outsider = await person("Lee Outsider", "owner", "+15555550109", await otherBusiness());
  refused(await call(regionsGet, await signIn(outsider.phoneE164!), { params }), 404);
});

withTestDb("the priced photo editor: an outline drawn by hand goes on a line, and one on no line can be taken off", async () => {
  const { crew, shrub, params } = await seeded();
  const crewHeaders = await signIn(crew.phoneE164!);
  const rect = (left: number, top: number, right: number, bottom: number) => [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  const square = (left: number, top: number, side: number) => rect(left, top, left + side, top + side);

  // A shrub SAM never found, outlined by hand onto the shrub line: kept under the line's name, and drawn without SAM.
  const real = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("no SAM call for a drawn outline"))) as typeof fetch;
  let drawn;
  try {
    drawn = await call(drawPost, crewHeaders, { params, body: { points: square(600, 700, 80), lineIndex: 1 } });
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(drawn.status, 200, JSON.stringify(drawn.body));
  const state = drawn.body as unknown as PricedPhotoEditorState & { candidateId: string; added: boolean };
  assert.equal(state.added, true);
  const hand = state.candidates.find((c) => c.id === state.candidateId);
  assert.deepEqual(hand && [hand.phrase, hand.source, hand.box, hand.areaPx, hand.confidence], [
    "Shrub trimming",
    "hand",
    { left: 600, top: 700, right: 680, bottom: 780 },
    6400,
    null,
  ]);
  assert.deepEqual(
    state.regions.map((r) => r.objects.map((o) => o.candidateId)),
    [[], [state.candidateId]],
  );
  assert.equal(state.editedBy, "Sam Crew");

  // Drawn over the shrub SAM found, the outline gives way to it, and that shrub goes on the line.
  const over = await call(drawPost, crewHeaders, { params, body: { points: rect(0, 494, 444, 645), lineIndex: 0 } });
  assert.equal(over.status, 200, JSON.stringify(over.body));
  const kept = over.body as unknown as PricedPhotoEditorState & { candidateId: string; added: boolean };
  assert.deepEqual([kept.added, kept.candidateId, kept.candidates.length], [false, shrub.id, 2]);
  assert.deepEqual(kept.regions[0].objects.map((o) => o.candidateId), [shrub.id]);

  // Kept on no line, it can be taken off; on a line, or found by SAM, it can't.
  const loose = await call(drawPost, crewHeaders, { params, body: { points: square(100, 100, 50) } });
  const looseState = loose.body as unknown as PricedPhotoEditorState & { candidateId: string };
  assert.equal(looseState.candidates.find((c) => c.id === looseState.candidateId)?.phrase, "drawn");
  assert.ok(looseState.regions.every((r) => r.objects.every((o) => o.candidateId !== looseState.candidateId)));
  const removed = await call(drawnDelete, crewHeaders, { method: "DELETE", params: { ...params, candidateId: looseState.candidateId } });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.ok(!(removed.body as unknown as PricedPhotoEditorState).candidates.some((c) => c.id === looseState.candidateId));
  refused(await call(drawnDelete, crewHeaders, { method: "DELETE", params: { ...params, candidateId: state.candidateId } }), 409, "ON_A_LINE");
  refused(await call(drawnDelete, crewHeaders, { method: "DELETE", params: { ...params, candidateId: shrub.id } }), 400, "NOT_DRAWN");
  refused(await call(drawnDelete, crewHeaders, { method: "DELETE", params: { ...params, candidateId: "cand_nope" } }), 400, "UNKNOWN_CANDIDATE");

  refused(await call(drawPost, crewHeaders, { params, body: { points: square(10, 10, 5) } }), 400, "BAD_OUTLINE");
  refused(await call(drawPost, crewHeaders, { params, body: { points: square(1000, 10, 50) } }), 400, "BAD_OUTLINE");
  refused(await call(drawPost, crewHeaders, { params, body: { points: square(10, 10, 50), lineIndex: 7 } }), 400, "UNKNOWN_LINE");
  refused(await call(drawPost, await superAdminViewing(TEST_ORG), { params, body: { points: square(10, 10, 50) } }), 403);
  const outsider = await person("Lee Outsider", "owner", "+15555550109", await otherBusiness());
  refused(await call(drawPost, await signIn(outsider.phoneE164!), { params, body: { points: square(10, 10, 50) } }), 404);
});

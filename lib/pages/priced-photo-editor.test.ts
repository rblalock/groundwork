// The priced photo editor's routes: anyone on the team reads the editor's state, moves the photo's
// objects between lines, asks SAM for the thing in a box, and outlines one by hand; a bad edit is a
// 400, another business's photo a 404.
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
const LAWN_STREAM = readFileSync(new URL("../../test-fixtures/sam/lawn.stream.txt", import.meta.url), "utf8");
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

withTestDb("the priced photo editor: a box with no phrase asks SAM for the one thing in it, and a tap off it asks again", async () => {
  const { crew, shrub, params } = await seeded();
  const crewHeaders = await signIn(crew.phoneE164!);
  // Every SAM call answers with the recorded lawn stream: three objects.
  const sent: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).endsWith("/responses")) return real(url, init);
    sent.push(JSON.parse(String(init?.body)).input[0].content[0].text);
    return new Response(LAWN_STREAM, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    type Found = PricedPhotoEditorState & { found: number; candidateIds: string[] };
    const box = { left: 0, top: 588, right: 1024, bottom: 1024 };
    const first = await call(findPost, crewHeaders, { params, body: { box } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const state = first.body as unknown as Found;
    assert.deepEqual(sent, ["<0f>1<|box;x1=0;y1=588;x2=1023;y2=1023;w=1024;h=1024|>"], "an object prompt, not a phrase");
    assert.equal(state.found, 3);
    const boxed = state.candidates.filter((c) => state.candidateIds.includes(c.id));
    assert.ok(boxed.length === 3 && boxed.every((c) => c.phrase === "selected"), "kept as selected, on no line");
    assert.ok(state.regions.every((r) => r.objects.every((o) => o.candidateId === shrub.id)));

    // Asked again onto a line, the same objects are kept already: nothing is added, and the answer names them.
    const same = await call(findPost, crewHeaders, { params, body: { box, lineIndex: 1 } });
    const sameState = same.body as unknown as Found;
    assert.deepEqual([sameState.found, new Set(sameState.candidateIds), sameState.regions[1].located], [0, new Set(state.candidateIds), false]);

    // Not the largest: a tap off it asks again with the box and that spot, and the answer, kept under the
    // line's name, takes its place.
    const wrong = boxed.reduce((a, b) => (b.areaPx > a.areaPx ? b : a));
    const points = [{ x: 500.6, y: 900.2, negative: true }];
    const again = await call(findPost, crewHeaders, { params, body: { box, points, lineIndex: 1, replace: wrong.id } });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const next = again.body as unknown as Found;
    assert.equal(sent[2], "<0f>1<|box;x1=0;y1=588;x2=1023;y2=1023;w=1024;h=1024|>-<|point;x=500;y=900;w=1024;h=1024|>");
    assert.equal(next.found, 1);
    assert.ok(!next.candidates.some((c) => c.id === wrong.id), "the wrong one is gone");
    assert.equal(next.candidates.length, 4);
    const answer = next.candidates.find((c) => !state.candidates.some((s) => s.id === c.id))!;
    assert.equal(answer.phrase, "Shrub trimming");
    assert.deepEqual(next.regions[1].objects.map((o) => o.candidateId), [answer.id]);

    const calls = sent.length;
    refused(await call(findPost, crewHeaders, { params, body: {} }), 400, "INVALID_INPUT");
    refused(await call(findPost, crewHeaders, { params, body: { phrase: "hedge", box, points } }), 400, "BAD_PROMPT");
    refused(await call(findPost, crewHeaders, { params, body: { box: { left: 1100, top: 0, right: 1200, bottom: 50 } } }), 400, "BAD_PROMPT");
    refused(await call(findPost, crewHeaders, { params, body: { box, points: [...points, ...points, ...points, ...points] } }), 400, "INVALID_INPUT");
    refused(await call(findPost, crewHeaders, { params, body: { box, replace: "cand_nope" } }), 400, "UNKNOWN_CANDIDATE");
    assert.equal(sent.length, calls, "no SAM call for a refused ask");
  } finally {
    globalThis.fetch = real;
  }
});

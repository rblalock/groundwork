// The priced photo editor's routes: anyone on the team reads the editor's state and moves the photo's
// objects between lines; a bad assignment is a 400, another business's photo a 404.
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
import { call, installTransport, otherBusiness, person, refused, signIn, superAdminViewing } from "./test-support";

const YARD = readFileSync(new URL("../../agents/assistant/evals/fixtures/yard-front.jpg", import.meta.url));
const quiet: Poster = async () => ({ posted: true });

withTestDb("the priced photo editor: read it, move an object to another line, and bad edits are refused", async () => {
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
  const params = { id: quote.quoteId, pricedId };

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

// Stored photos and renders go to a temp folder as file:// URLs, so they read back.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.BLOB_LOCAL_DIR = mkdtempSync(join(tmpdir(), "priced-photo-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { quoteAttachments } from "../schema/schema";
import type { PricedRegion } from "../schema/types";
import { landscaping } from "../verticals/landscaping";
import { storeInboundAttachment } from "./blob";
import { db, newId } from "./db";
import { createMember, type Caller } from "./members";
import { saveItems } from "./pricebook";
import { createPricedPhoto, pricedPhotosFor, renderOverlay } from "./priced-photo";
import { createQuote, type Poster } from "./quotes";
import { TEST_ORG, withTestDb } from "./test-db";

const YARD = readFileSync(new URL("../agents/assistant/evals/fixtures/yard-front.jpg", import.meta.url));

const region = (lineIndex: number, name: string, quantity: number, unitLabel: string, totalCents: number, boxes: number[][]): PricedRegion => ({
  lineIndex,
  itemId: null,
  name,
  quantity,
  unitLabel,
  totalCents,
  phrase: "test",
  objects: boxes.map(([left, top, right, bottom]) => ({ box: { left, top, right, bottom }, areaPx: (right - left) * (bottom - top), confidence: 0.9 })),
  located: boxes.length > 0,
});

test("draws the regions and a legend under the photo; two lines on one bed share a label", async () => {
  const bed = [0, 564, 494, 696];
  const regions = [
    region(0, "Mulch installed", 3, "cubic yard", 28500, [bed]),
    region(1, "Bed edging", 40, "linear foot", 10000, [bed]),
    region(2, "Hedge trimming", 1, "hour", 7500, [[0, 494, 444, 645]]),
    region(3, "Sprinkler head replacement", 2, "head", 7000, []),
  ];
  const { png, width, height } = await renderOverlay({ bytes: new Uint8Array(YARD), width: 1024, height: 1024 }, regions, new Map(), 53000, "en");
  const meta = await sharp(png).metadata();
  assert.equal(meta.format, "png");
  assert.equal(meta.width, 1024);
  assert.equal(width, 1024);
  assert.equal(meta.height, height);
  assert.ok(height > 1024, "the legend sits under the photo");
  assert.ok(png.byteLength > 50_000);
  if (process.env.PRICED_PHOTO_OUT) writeFileSync(process.env.PRICED_PHOTO_OUT, png);
});

const post: Poster = async () => ({ posted: true });

async function seed() {
  const member = await createMember({ orgId: TEST_ORG, name: "Pat", role: "owner" });
  const owner: Caller = { orgId: TEST_ORG, memberId: member.id, name: "Pat", role: "owner", language: "en", phoneE164: null };
  const items = new Map((await saveItems(TEST_ORG, landscaping.items, owner.memberId)).map((item) => [item.name, item]));
  return { owner, items };
}

async function quoteWith(owner: Caller, lines: Array<{ itemId: string; quantity: number }>, photo?: { url: string; mimeType: string }) {
  const quote = await createQuote({ title: "412 Oak St front yard", lines }, owner, { post });
  if (photo) {
    await db()
      .insert(quoteAttachments)
      .values({ id: newId("att"), orgId: TEST_ORG, quoteId: quote.quoteId, uploadedByMemberId: owner.memberId, url: photo.url, name: "yard.jpg", mimeType: photo.mimeType });
  }
  return quote;
}

withTestDb("priced photo: no photo, an unreadable one, or no such quote is a reason, not an error", async () => {
  const { owner, items } = await seed();
  const lines = [{ itemId: items.get("Lawn mowing")!.id, quantity: 1 }];
  const bare = await quoteWith(owner, lines);
  assert.deepEqual(await createPricedPhoto(owner, { quoteId: bare.quoteId }), { pricedPhotoId: null, reason: "no_photo" });
  const faked = await quoteWith(owner, lines, { url: "fake://inbound/yard.jpg", mimeType: "image/jpeg" });
  assert.deepEqual(await createPricedPhoto(owner, { quoteId: faked.quoteId }), { pricedPhotoId: null, reason: "unreadable_photo" });
  assert.deepEqual(await createPricedPhoto(owner, { quoteId: "quo_missing" }), { pricedPhotoId: null, reason: "quote_not_found" });
});

withTestDb("priced photo: making it again replaces the one for that photo", async () => {
  const { owner, items } = await seed();
  // Cleanup labor has no photo prompt, so nothing is sent to SAM and the line is listed as not located.
  const url = await storeInboundAttachment("yard.jpg", "image/jpeg", new Uint8Array(YARD));
  const quote = await quoteWith(owner, [{ itemId: items.get("Cleanup labor")!.id, quantity: 2 }], { url, mimeType: "image/jpeg" });
  const first = await createPricedPhoto(owner, { quoteId: quote.quoteId });
  assert.ok(first.pricedPhotoId);
  assert.deepEqual([first.located, first.notLocated], [0, ["Cleanup labor"]]);
  const again = await createPricedPhoto(owner, { quoteId: quote.quoteId });
  assert.equal(again.pricedPhotoId, first.pricedPhotoId);
  const rows = await pricedPhotosFor(TEST_ORG, quote.quoteId);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].url, rows[0].sourceUrl], [again.pricedPhotoId && again.url, url]);
});

// Calls SAM: runs only with a key, and leaves the render at /tmp/priced-photo.png for a look.
const live = process.env.META_MODEL_API_KEY ? withTestDb : (name: string) => test(name, { skip: "META_MODEL_API_KEY is not set" }, () => {});
live("priced photo: the yard fixture with mulch, edging, hedge and mowing (live)", async () => {
  const { owner, items } = await seed();
  const url = await storeInboundAttachment("yard.jpg", "image/jpeg", new Uint8Array(YARD));
  const quote = await quoteWith(
    owner,
    [
      { itemId: items.get("Mulch installed")!.id, quantity: 3 },
      { itemId: items.get("Hedge trimming")!.id, quantity: 1 },
      { itemId: items.get("Lawn mowing")!.id, quantity: 1 },
      { itemId: items.get("Bed edging")!.id, quantity: 40 },
    ],
    { url, mimeType: "image/jpeg" },
  );
  const result = await createPricedPhoto(owner, { quoteId: quote.quoteId });
  assert.ok(result.pricedPhotoId);
  assert.ok(result.located >= 3, JSON.stringify(result.regions));
  writeFileSync("/tmp/priced-photo.png", readFileSync(fileURLToPath(result.url)));
});
